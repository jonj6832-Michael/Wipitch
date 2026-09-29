/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/webgpu';
import { installSwiftF0Worker } from './swiftf0-engine';

installSwiftF0Worker(ort, 'webgpu');
