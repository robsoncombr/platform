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

import { type Resources } from '@hcengineering/platform'
import TestCase from './components/TestCase.svelte'
import NewTestCaseHeader from './components/test-case/NewTestCaseHeader.svelte'
import CreateProject from './components/project/CreateProject.svelte'
import ProjectSpacePresenter from './components/project/ProjectSpacePresenter.svelte'
import CreateTestSuite from './components/test-suite/CreateTestSuite.svelte'
import EditTestSuite from './components/test-suite/EditTestSuite.svelte'
import TestSuitePresenter from './components/test-suite/TestSuitePresenter.svelte'
import EditTestCase from './components/test-case/EditTestCase.svelte'
import TestCasePresenter from './components/test-case/TestCasePresenter.svelte'

export default async (): Promise<Resources> => ({
  component: {
    TestCase,
    NewTestCaseHeader,
    CreateProject,
    ProjectSpacePresenter,
    CreateTestSuite,
    EditTestSuite,
    TestSuitePresenter,
    EditTestCase,
    TestCasePresenter
  }
})
