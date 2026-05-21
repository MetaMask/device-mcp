/** @type {import('@yarnpkg/types')} */
const { defineConfig } = require('@yarnpkg/types');
const { basename } = require('path');

/**
 * @typedef {import('@yarnpkg/types').Yarn.Constraints.Yarn} Yarn
 * @typedef {import('@yarnpkg/types').Yarn.Constraints.Workspace} Workspace
 * @typedef {import('@yarnpkg/types').Yarn.Constraints.Dependency} Dependency
 */

const BASE_URL = 'https://github.com/MetaMask/';

/**
 *
 * @param workspace
 */
function getWorkspaceName(workspace) {
  return basename(workspace.ident);
}

/**
 *
 * @param workspace
 * @param field
 * @param value
 */
function expectWorkspaceField(workspace, field, value) {
  const fieldValue = workspace.manifest[field];
  if (fieldValue === null) {
    workspace.error(`Missing required field "${field}".`);
    return;
  }
  if (value) {
    workspace.set(field, value);
  }
}

/**
 *
 * @param workspace
 */
function expectWorkspaceDescription(workspace) {
  expectWorkspaceField(workspace, 'description');
  const { description } = workspace.manifest;
  if (typeof description !== 'string') {
    workspace.error(`Expected description to be a string.`);
    return;
  }
  if (description.endsWith('.')) {
    workspace.set('description', description.slice(0, -1));
  }
}

/**
 *
 * @param workspace
 */
function expectWorkspaceDependencies(workspace) {
  workspace.pkg.dependencies.forEach((dependency) => {
    const isDependency = Boolean(
      workspace.manifest.dependencies?.[dependency.ident],
    );
    const isDevDependency = Boolean(
      workspace.manifest.devDependencies?.[dependency.ident],
    );
    if (isDependency && isDevDependency) {
      workspace.unset(`devDependencies.${dependency.ident}`);
    }
  });
}

/**
 *
 * @param workspace
 */
function expectExports(workspace) {
  const { exports: manifestExports } = workspace.manifest;
  Object.entries(manifestExports)
    .filter(([, exportValue]) => typeof exportValue !== 'string')
    .forEach(([exportName, exportObject]) => {
      const keys = Object.keys(exportObject);
      if (keys.includes('types') && keys[0] !== 'types') {
        workspace.error(
          `The "types" export must be first for "${exportName}".`,
        );
      }
    });
}

module.exports = defineConfig({
  /**
   *
   * @param options0
   * @param options0.Yarn
   */
  async constraints({ Yarn }) {
    const workspace = Yarn.workspace();
    const workspaceName = getWorkspaceName(workspace);
    const workspaceRepository = `${BASE_URL}${workspaceName}`;

    expectWorkspaceField(workspace, 'name', `@metamask/${workspaceName}`);
    expectWorkspaceField(workspace, 'version');
    expectWorkspaceField(workspace, 'license');
    expectWorkspaceDescription(workspace);
    expectWorkspaceDependencies(workspace);

    workspace.set('homepage', `${workspaceRepository}#readme`);
    workspace.set('bugs.url', `${workspaceRepository}/issues`);
    workspace.set('repository.type', 'git');
    workspace.set('repository.url', `${workspaceRepository}.git`);
    workspace.set('engines.node', '^20 || ^22 || >=24');
    workspace.set('main', './dist/index.cjs');
    workspace.set('exports["."].require.default', './dist/index.cjs');
    workspace.set('types', './dist/index.d.cts');
    workspace.set('exports["."].require.types', './dist/index.d.cts');
    workspace.set('module', './dist/index.mjs');
    workspace.set('exports["."].import.default', './dist/index.mjs');
    workspace.set('exports["."].import.types', './dist/index.d.mts');
    workspace.set('exports["./package.json"]', './package.json');
    expectExports(workspace);
    workspace.set('files', ['dist']);
    workspace.unset('private');
    workspace.set('publishConfig.access', 'public');
    workspace.set('publishConfig.registry', 'https://registry.npmjs.org/');
  },
});
