/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm';
import { installSwiftF0Worker } from './swiftf0-engine';

installSwiftF0Worker(ort, 'wasm');
