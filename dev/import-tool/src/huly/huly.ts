//
// Copyright © 2024 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import { type Attachment } from '@hcengineering/attachment'
import contact, { type Person, type PersonAccount } from '@hcengineering/contact'
import { type Class, type Doc, generateId, type Ref, type Space, type TxOperations } from '@hcengineering/core'
import { type Document } from '@hcengineering/document'
import { MarkupMarkType, type MarkupNode, MarkupNodeType, traverseNode, traverseNodeMarks } from '@hcengineering/text'
import { type Issue } from '@hcengineering/tracker'
import * as fs from 'fs'
import * as yaml from 'js-yaml'
import { contentType } from 'mime-types'
import * as path from 'path'
import { ImportWorkspaceBuilder } from '../importer/builder'
import {
  type ImportAttachment,
  type ImportComment,
  type ImportDocument,
  type ImportIssue,
  type ImportProject,
  type ImportProjectType,
  type ImportTeamspace,
  type ImportWorkspace,
  type MarkdownPreprocessor,
  WorkspaceImporter
} from '../importer/importer'
import { type FileUploader } from '../importer/uploader'

interface HulyComment {
  author: string
  date: string
  text: string
}

interface HulyIssueHeader {
  class: string
  title: string
  assignee: string
  status: string
  priority: string
  estimation: number
  remainingTime: number
  comments?: HulyComment[]
}

interface HulySpaceHeader {
  class: string
  title: string
  private?: boolean
  autoJoin?: boolean
  owners?: string[]
  members?: string[]
}

interface HulyProjectHeader extends HulySpaceHeader {
  class: 'tracker.class.Project'
  identifier?: string
  projectType?: string
  defaultAssignee?: string
  defaultIssueStatus?: string
  description?: string
}

interface HulyTeamSpaceHeader extends HulySpaceHeader {
  class: 'document.class.TeamSpace'
}

interface HulyWorkspaceSettings {
  projectTypes?: Array<{
    name: string
    taskTypes?: Array<{
      name: string
      description: string
      statuses: Array<{
        name: string
        description: string
      }>
    }>
  }>
}

interface HulyDocumentHeader {
  class: string
  title: string
}

class HulyMarkdownPreprocessor implements MarkdownPreprocessor {
  private readonly MENTION_REGEX = /@([A-Za-z]+ [A-Za-z]+)/g

  constructor (
    private readonly urlProvider: (id: string) => string,
    private readonly metadataByFilePath: Map<string, DocMetadata>,
    private readonly metadataById: Map<Ref<Doc>, DocMetadata>,
    private readonly attachMetadataByPath: Map<string, AttachmentMetadata>,
    private readonly personsByName: Map<string, Ref<Person>>
  ) {}

  process (json: MarkupNode, id: Ref<Doc>, spaceId: Ref<Space>): MarkupNode {
    traverseNode(json, (node) => {
      if (node.type === MarkupNodeType.image) {
        const src = node.attrs?.src
        if (src !== undefined) {
          const sourceMeta = this.metadataById.get(id)
          if (sourceMeta == null) {
            console.warn(`Source metadata not found for ${id}`)
            return
          }
          const href = decodeURI(src as string)
          const fullPath = path.resolve(path.dirname(sourceMeta.path), href)
          const attachmentMeta = this.attachMetadataByPath.get(fullPath)
          if (attachmentMeta === undefined) {
            console.warn(`Attachment image not found for ${fullPath}`)
            return
          }

          this.attachMetadataByPath.set(fullPath, {
            ...attachmentMeta,
            spaceId,
            parentId: id,
            parentClass: sourceMeta.class as Ref<Class<Doc<Space>>>
          })
          this.alterImageNode(node, attachmentMeta.id, attachmentMeta.name)
        }
      } else {
        traverseNodeMarks(node, (mark) => {
          if (mark.type === MarkupMarkType.link) {
            const sourceMeta = this.metadataById.get(id)
            if (sourceMeta == null) {
              console.warn(`Source metadata not found for ${id}`)
              return
            }
            const href = decodeURI(mark.attrs.href)
            const fullPath = path.resolve(path.dirname(sourceMeta.path), href)
            if (this.metadataByFilePath.has(fullPath)) {
              const targetDocMeta = this.metadataByFilePath.get(fullPath)
              if (targetDocMeta !== undefined) {
                this.alterInternalLinkNode(node, targetDocMeta)
              }
            } else if (this.attachMetadataByPath.has(fullPath)) {
              const attachmentMeta = this.attachMetadataByPath.get(fullPath)
              if (attachmentMeta !== undefined) {
                this.alterAttachmentLinkNode(node, attachmentMeta)
                this.attachMetadataByPath.set(fullPath, {
                  ...attachmentMeta,
                  spaceId,
                  parentId: id,
                  parentClass: sourceMeta.class as Ref<Class<Doc<Space>>>
                })
              }
            } else {
              console.log('Unknown link type, leave it as is:', href)
            }
          }
        })
        this.findAndAlterMentions(node)
      }
      return true
    })
    return json
  }

  private findAndAlterMentions (node: MarkupNode): boolean {
    if (node.type === MarkupNodeType.paragraph && node.content !== undefined) {
      const newContent: MarkupNode[] = []
      for (const childNode of node.content) {
        if (childNode.type === MarkupNodeType.text && childNode.text !== undefined) {
          let match
          let lastIndex = 0
          let hasMentions = false

          while ((match = this.MENTION_REGEX.exec(childNode.text)) !== null) {
            hasMentions = true
            if (match.index > lastIndex) {
              newContent.push({
                type: MarkupNodeType.text,
                text: childNode.text.slice(lastIndex, match.index),
                marks: childNode.marks,
                attrs: childNode.attrs
              })
            }

            const name = match[1]
            const personRef = this.personsByName.get(name)
            if (personRef !== undefined) {
              newContent.push({
                type: MarkupNodeType.reference,
                attrs: {
                  id: personRef,
                  label: name,
                  objectclass: contact.class.Person
                }
              })
            } else {
              newContent.push({
                type: MarkupNodeType.text,
                text: match[0],
                marks: childNode.marks,
                attrs: childNode.attrs
              })
            }

            lastIndex = this.MENTION_REGEX.lastIndex
          }

          if (hasMentions) {
            if (lastIndex < childNode.text.length) {
              newContent.push({
                type: MarkupNodeType.text,
                text: childNode.text.slice(lastIndex),
                marks: childNode.marks,
                attrs: childNode.attrs
              })
            }
          } else {
            newContent.push(childNode)
          }
        } else {
          newContent.push(childNode)
        }
      }

      node.content = newContent
      return false
    }
    return true
  }

  private alterImageNode (node: MarkupNode, id: string, name: string): void {
    node.type = MarkupNodeType.image
    if (node.attrs !== undefined) {
      node.attrs = {
        'file-id': id,
        src: this.urlProvider(id),
        width: node.attrs.width ?? null,
        height: node.attrs.height ?? null,
        align: node.attrs.align ?? null,
        alt: name,
        title: name
      }
      const mimeType = this.getContentType(name)
      if (mimeType !== undefined) {
        node.attrs['data-file-type'] = mimeType
      }
    }
  }

  private alterInternalLinkNode (node: MarkupNode, targetMeta: DocMetadata): void {
    node.type = MarkupNodeType.reference
    node.attrs = {
      id: targetMeta.id,
      label: targetMeta.refTitle,
      objectclass: targetMeta.class,
      text: '',
      content: ''
    }
  }

  private alterAttachmentLinkNode (node: MarkupNode, targetMeta: AttachmentMetadata): void {
    const stats = fs.statSync(targetMeta.path)
    node.type = MarkupNodeType.file
    node.attrs = {
      'file-id': targetMeta.id,
      'data-file-name': targetMeta.name,
      'data-file-size': stats.size,
      'data-file-href': targetMeta.path
    }
    const mimeType = this.getContentType(targetMeta.name)
    if (mimeType !== undefined) {
      node.attrs['data-file-type'] = mimeType
    }
  }

  private getContentType (fileName: string): string | undefined {
    const mimeType = contentType(fileName)
    return mimeType !== false ? mimeType : undefined
  }
}

interface DocMetadata {
  id: Ref<Doc>
  class: string
  path: string
  refTitle: string
}

interface AttachmentMetadata {
  id: Ref<Attachment>
  name: string
  path: string
  parentId?: Ref<Doc>
  parentClass?: Ref<Class<Doc<Space>>>
  spaceId?: Ref<Space>
}

export class HulyImporter {
  private readonly metadataByFilePath = new Map<string, DocMetadata>()
  private readonly metadataById = new Map<Ref<Doc>, DocMetadata>()
  private readonly attachMetadataByPath = new Map<string, AttachmentMetadata>()

  private personsByName = new Map<string, Ref<Person>>()
  private accountsByEmail = new Map<string, Ref<PersonAccount>>()

  constructor (
    private readonly client: TxOperations,
    private readonly fileUploader: FileUploader
  ) {}

  async importHulyFolder (folderPath: string): Promise<void> {
    await this.cachePersonsByNames()
    await this.cacheAccountsByEmails()

    const workspaceData = await this.processHulyFolder(folderPath)

    console.log('========================================')
    console.log('IMPORT DATA STRUCTURE: ', JSON.stringify(workspaceData, null, 4))
    console.log('========================================')

    console.log('Importing documents...')
    const preprocessor = new HulyMarkdownPreprocessor(
      this.fileUploader.getFileUrl,
      this.metadataByFilePath,
      this.metadataById,
      this.attachMetadataByPath,
      this.personsByName
    )
    await new WorkspaceImporter(this.client, this.fileUploader, workspaceData, preprocessor).performImport()

    console.log('Importing attachments...')
    const attachments: ImportAttachment[] = Array.from(this.attachMetadataByPath.values())
      .filter(attachment => attachment.parentId !== undefined)
      .map(attachment => {
        return {
          id: attachment.id,
          title: path.basename(attachment.path),
          blobProvider: async () => {
            const data = fs.readFileSync(attachment.path)
            return new Blob([data])
          },
          parentId: attachment.parentId,
          parentClass: attachment.parentClass,
          spaceId: attachment.spaceId
        }
      })
    await new WorkspaceImporter(this.client, this.fileUploader, { attachments }, preprocessor).performImport()

    console.log('========================================')
    console.log('IMPORT SUCCESS')
  }

  private async processHulyFolder (folderPath: string): Promise<ImportWorkspace> {
    const builder = new ImportWorkspaceBuilder(true) // strict mode

    // Load workspace settings
    const wsSettingsPath = path.join(folderPath, 'settings.yaml')
    const wsSettings = yaml.load(fs.readFileSync(wsSettingsPath, 'utf8')) as HulyWorkspaceSettings

    // Add project types
    for (const pt of this.processProjectTypes(wsSettings)) {
      builder.addProjectType(pt)
    }

    // Process spaces
    const folders = fs.readdirSync(folderPath)
      .filter(f => fs.statSync(path.join(folderPath, f)).isDirectory())

    for (const folder of folders) {
      const spacePath = path.join(folderPath, folder)
      const yamlPath = path.join(folderPath, `${folder}.yaml`)

      if (!fs.existsSync(yamlPath)) {
        console.warn(`Skipping ${folder}: no ${folder}.yaml found`)
        continue
      }

      try {
        console.log(`Processing ${folder}...`)
        const spaceConfig = yaml.load(fs.readFileSync(yamlPath, 'utf8')) as HulySpaceHeader

        switch (spaceConfig.class) {
          case 'tracker.class.Project': {
            const project = await this.processProject(spacePath, folder, spaceConfig as HulyProjectHeader)
            builder.addProject(spacePath, project)

            // Process all issues recursively and add them to builder
            await this.processIssuesRecursively(builder, project.identifier, spacePath, spacePath)
            break
          }

          case 'document.class.TeamSpace': {
            const teamspace = await this.processTeamspace(spacePath, folder, spaceConfig as HulyTeamSpaceHeader)
            builder.addTeamspace(spacePath, teamspace)

            // Process all documents recursively and add them to builder
            await this.processDocumentsRecursively(builder, spacePath, spacePath)
            break
          }
        }
      } catch (error) {
        console.warn(`Invalid space configuration in ${folder}: `, error)
      }
    }

    await this.processAttachments(folderPath)
    return builder.build()
  }

  private async processIssuesRecursively (
    builder: ImportWorkspaceBuilder,
    projectIdentifier: string,
    projectPath: string,
    currentPath: string,
    parentIssuePath?: string
  ): Promise<void> {
    const issueFiles = fs.readdirSync(currentPath)
      .filter(f => f.endsWith('.md'))

    for (const issueFile of issueFiles) {
      const issuePath = path.join(currentPath, issueFile)
      const issueHeader = await this.readYamlHeader(issuePath) as HulyIssueHeader
      const numberMatch = issueFile.match(/^(\d+)\./)

      if (issueHeader.class === 'tracker.class.Issue' && numberMatch != null) {
        const issueNumber = numberMatch[1]

        const meta: DocMetadata = {
          id: generateId<Issue>(),
          class: 'tracker:class:Issue',
          path: issuePath,
          refTitle: projectIdentifier + '-' + issueNumber
        }
        this.metadataById.set(meta.id, meta)
        this.metadataByFilePath.set(issuePath, meta)

        const issue: ImportIssue = {
          id: meta.id as Ref<Issue>,
          class: 'tracker.class.Issue',
          title: issueHeader.title,
          number: parseInt(issueNumber),
          descrProvider: async () => await this.readMarkdownContent(issuePath),
          status: { name: issueHeader.status },
          estimation: issueHeader.estimation,
          remainingTime: issueHeader.remainingTime,
          comments: this.processComments(issueHeader.comments),
          subdocs: [], // Will be added via builder
          assignee: this.personsByName.get(issueHeader.assignee)
        }

        builder.addIssue(projectPath, issuePath, issue, parentIssuePath)

        // Process sub-issues if they exist
        const subDir = path.join(currentPath, issueFile.replace('.md', ''))
        if (fs.existsSync(subDir) && fs.statSync(subDir).isDirectory()) {
          await this.processIssuesRecursively(builder, projectIdentifier, projectPath, subDir, issuePath)
        }
      }
    }
  }

  private async processDocumentsRecursively (
    builder: ImportWorkspaceBuilder,
    teamspacePath: string,
    currentPath: string,
    parentDocPath?: string
  ): Promise<void> {
    const docFiles = fs.readdirSync(currentPath)
      .filter(f => f.endsWith('.md'))

    for (const docFile of docFiles) {
      const docPath = path.join(currentPath, docFile)
      const docHeader = await this.readYamlHeader(docPath) as HulyDocumentHeader

      if (docHeader.class === 'document.class.Document') {
        const docMeta: DocMetadata = {
          id: generateId<Document>(),
          class: 'document:class:Document',
          path: docPath,
          refTitle: docHeader.title
        }
        this.metadataById.set(docMeta.id, docMeta)
        this.metadataByFilePath.set(docPath, docMeta)

        const doc: ImportDocument = {
          id: docMeta.id as Ref<Document>,
          class: 'document:class:Document',
          title: docHeader.title ?? path.basename(docFile, '.md'),
          descrProvider: async () => await this.readMarkdownContent(docPath),
          subdocs: [] // Will be added via builder
        }

        builder.addDocument(teamspacePath, docPath, doc, parentDocPath)

        // Process subdocuments if they exist
        const subDir = path.join(currentPath, docFile.replace('.md', ''))
        if (fs.existsSync(subDir) && fs.statSync(subDir).isDirectory()) {
          await this.processDocumentsRecursively(builder, teamspacePath, subDir, docPath)
        }
      }
    }
  }

  private processComments (comments: HulyComment[] = []): ImportComment[] {
    return comments.map(comment => ({
      text: comment.text,
      author: this.accountsByEmail.get(comment.author),
      date: new Date(comment.date).getTime()
    }))
  }

  private processProjectTypes (wsHeader: HulyWorkspaceSettings): ImportProjectType[] {
    return wsHeader.projectTypes?.map(pt => ({
      name: pt.name,
      taskTypes: pt.taskTypes?.map(tt => ({
        name: tt.name,
        description: tt.description,
        statuses: tt.statuses.map(st => ({
          name: st.name,
          description: st.description
        }))
      }))
    })) ?? []
  }

  private async processProject (
    spacePath: string,
    name: string,
    projectHeader: HulyProjectHeader
  ): Promise<ImportProject> {
    const projectType = projectHeader.projectType !== undefined
      ? this.findProjectType(projectHeader.projectType)
      : undefined

    return {
      class: projectHeader.class,
      title: projectHeader.title ?? name,
      identifier: projectHeader.identifier ?? name.toLowerCase().replace(/\s+/g, '-'),
      private: projectHeader.private ?? false,
      autoJoin: projectHeader.autoJoin ?? true,
      projectType,
      docs: [],
      defaultAssignee: projectHeader.defaultAssignee !== undefined
        ? { name: projectHeader.defaultAssignee, email: '' }
        : undefined,
      defaultIssueStatus: projectHeader.defaultIssueStatus !== undefined
        ? { name: projectHeader.defaultIssueStatus }
        : undefined,
      owners: projectHeader.owners?.map(email => ({ name: '', email })),
      members: projectHeader.members?.map(email => ({ name: '', email })),
      description: projectHeader.description
    }
  }

  private async processTeamspace (
    spacePath: string,
    name: string,
    spaceHeader: HulyTeamSpaceHeader
  ): Promise<ImportTeamspace> {
    return {
      class: spaceHeader.class,
      title: spaceHeader.title ?? name,
      private: spaceHeader.private ?? false,
      autoJoin: spaceHeader.autoJoin ?? true,
      owners: spaceHeader.owners?.map(email => ({ name: '', email })),
      members: spaceHeader.members?.map(email => ({ name: '', email })),
      docs: []
    }
  }

  private async readYamlHeader (filePath: string): Promise<any> {
    console.log('Read YAML header from: ', filePath)
    const content = fs.readFileSync(filePath, 'utf8')
    const match = content.match(/^---\n([\s\S]*?)\n---/)
    if (match != null) {
      return yaml.load(match[1])
    }
    return {}
  }

  private async readMarkdownContent (filePath: string): Promise<string> {
    const content = fs.readFileSync(filePath, 'utf8')
    const match = content.match(/^---\n[\s\S]*?\n---\n(.*)$/s)
    return match != null ? match[1] : content
  }

  private findProjectType (name: string): ImportProjectType {
    return {
      name,
      taskTypes: []
    }
  }

  private async cachePersonsByNames (): Promise<void> {
    this.personsByName = (await this.client.findAll(contact.class.Person, {}))
      .map((person) => {
        return {
          _id: person._id,
          name: person.name.split(',').reverse().join(' ')
        }
      })
      .reduce((refByName, person) => {
        refByName.set(person.name, person._id)
        return refByName
      }, new Map())
  }

  private async cacheAccountsByEmails (): Promise<void> {
    const accounts = await this.client.findAll(contact.class.PersonAccount, {})
    this.accountsByEmail = accounts.reduce((map, account) => {
      map.set(account.email, account._id)
      return map
    }, new Map())
  }

  private async processAttachments (folderPath: string): Promise<void> {
    const processDir = async (dir: string): Promise<void> => {
      const entries = fs.readdirSync(dir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)

        if (entry.isDirectory()) {
          await processDir(fullPath)
        } else if (entry.isFile()) {
          // Skip files that are already processed as documents or issues
          if (!this.metadataByFilePath.has(fullPath)) {
            const attachmentId = generateId<Attachment>()
            this.attachMetadataByPath.set(fullPath, { id: attachmentId, name: entry.name, path: fullPath })
            console.log(`Found attachment: ${fullPath} -> ${attachmentId}`)
          }
        }
      }
    }

    await processDir(folderPath)
  }
}
