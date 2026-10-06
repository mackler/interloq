// The live platform services of Node.js (finding 27: split from the Store so that the Store is one thing).

import { Layer, type FileSystem, type Path } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";

/** The platform services the store and the readers need. */
export type Platform = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

/** The live platform services of Node.js. */
export const platformLayer: Layer.Layer<Platform> = Layer.provideMerge(NodeChildProcessSpawner.layer, Layer.mergeAll(NodeFileSystem.layer, NodePath.layer));
