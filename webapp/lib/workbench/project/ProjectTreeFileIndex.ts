/*
 * Exports:
 * - ProjectTreeFileCandidate: flattened file path plus ignored metadata for mention suggestions. Keywords: tree, file mention, ignored.
 * - ProjectTreeFileIndex: stable flattened project file candidates and paths. Keywords: tree, file index, cache.
 * - default ProjectTreeFileIndex: build and reuse stable project file indexes from tree snapshots. Keywords: tree traversal, referential cache, mentions.
 */

import type { TreeNode } from "../../types";

export interface ProjectTreeFileCandidate {
  readonly isIgnored: boolean;
  readonly path: string;
}

export interface ProjectTreeFileIndex {
  readonly candidates: readonly ProjectTreeFileCandidate[];
  readonly id: string;
  readonly key: string;
  readonly paths: readonly string[];
}

interface ProjectTreeFileIndexBuilder {
  count: number;
  hash: number;
  totalLength: number;
}

const EMPTY_PROJECT_TREE_FILE_INDEX: ProjectTreeFileIndex = {
  candidates: [],
  id: "project-files:empty",
  key: "0:0:ztntfp",
  paths: [],
};
let nextProjectTreeFileIndexId = 1;

function createProjectTreeFileIndexBuilder(): ProjectTreeFileIndexBuilder {
  return {
    count: 0,
    hash: 2_166_136_261,
    totalLength: 0,
  };
}

function addProjectTreeFileIndexKeyValue(builder: ProjectTreeFileIndexBuilder, value: string) {
  builder.count += 1;
  builder.totalLength += value.length;
  for (let index = 0; index < value.length; index += 1) {
    builder.hash ^= value.charCodeAt(index);
    builder.hash = Math.imul(builder.hash, 16_777_619);
  }

  builder.hash ^= 0;
  builder.hash = Math.imul(builder.hash, 16_777_619);
}

function finishProjectTreeFileIndexKey(builder: ProjectTreeFileIndexBuilder) {
  return `${builder.count}:${builder.totalLength}:${(builder.hash >>> 0).toString(36)}`;
}

function visitProjectTreeFiles(nodes: readonly TreeNode[], visitor: (node: Extract<TreeNode, { type: "file" }>) => void) {
  const stack: TreeNode[] = [];
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    stack.push(nodes[index]);
  }

  while (stack.length) {
    const node = stack.pop();
    if (!node) {
      continue;
    }

    if (node.type === "file") {
      visitor(node);
      continue;
    }

    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]);
    }
  }
}

function areProjectTreeFileCandidatesEqual(
  left: readonly ProjectTreeFileCandidate[],
  right: readonly ProjectTreeFileCandidate[],
) {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index].path !== right[index].path || left[index].isIgnored !== right[index].isIgnored) {
      return false;
    }
  }

  return true;
}

function createProjectTreeFileIndex(nodes: readonly TreeNode[]): ProjectTreeFileIndex {
  const builder = createProjectTreeFileIndexBuilder();
  const candidates: ProjectTreeFileCandidate[] = [];
  const paths: string[] = [];

  visitProjectTreeFiles(nodes, (node) => {
    const candidate = {
      isIgnored: Boolean(node.isIgnored),
      path: node.path,
    };
    candidates.push(candidate);
    paths.push(candidate.path);
    addProjectTreeFileIndexKeyValue(builder, candidate.isIgnored ? "1" : "0");
    addProjectTreeFileIndexKeyValue(builder, candidate.path);
  });

  if (!candidates.length) {
    return EMPTY_PROJECT_TREE_FILE_INDEX;
  }

  return {
    candidates,
    id: `project-files:${nextProjectTreeFileIndexId++}`,
    key: finishProjectTreeFileIndexKey(builder),
    paths,
  };
}

function reuseProjectTreeFileIndex(
  nextIndex: ProjectTreeFileIndex,
  previousIndex: ProjectTreeFileIndex,
): ProjectTreeFileIndex {
  return nextIndex.key === previousIndex.key
    && areProjectTreeFileCandidatesEqual(nextIndex.candidates, previousIndex.candidates)
    ? previousIndex
    : nextIndex;
}

const ProjectTreeFileIndex = {
  empty: EMPTY_PROJECT_TREE_FILE_INDEX,
  fromTree(nodes: readonly TreeNode[], previousIndex: ProjectTreeFileIndex = EMPTY_PROJECT_TREE_FILE_INDEX) {
    return reuseProjectTreeFileIndex(createProjectTreeFileIndex(nodes), previousIndex);
  },
};

export default ProjectTreeFileIndex;
