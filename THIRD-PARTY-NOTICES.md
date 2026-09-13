# Third-party components

Kline itself is proprietary — see `LICENSE`. Two third-party components are
redistributed inside the application, both under permissive licences that allow
commercial redistribution inside a proprietary product. Those components keep
their own terms, which are reproduced or linked below, and this file travels
with every build because those licences require it to.

## Depth Anything V2 Small — Apache License 2.0

`public/models/depth-anything-v2-small-int8.onnx` (26MB) is the Depth Anything
V2 Small monocular depth model, exported to ONNX and quantised to eight bits.

- Model: <https://huggingface.co/depth-anything/Depth-Anything-V2-Small>
- ONNX export used: <https://huggingface.co/onnx-community/depth-anything-v2-small>
  (`onnx/model_quantized.onnx`, sha256
  `fcf51f1b230362b28690bb9d1809bf0431f29cad20534e3f589bd7285547f20d`)
- Licence: Apache License 2.0 — <https://www.apache.org/licenses/LICENSE-2.0>
- Paper: Yang et al., *Depth Anything V2*, 2024.

The Apache 2.0 licence requires that this notice, the licence text and any
attribution accompany redistribution. A full copy of the licence is at
`licences/Apache-2.0.txt`.

This model was not trained, modified or fine-tuned by this project; it is
redistributed as exported, and used only to estimate depth from a picture the
user supplies. It runs entirely on the user's machine.

## ONNX Runtime Web — MIT License

The WebAssembly build of ONNX Runtime (`public/ort/`, and the `onnxruntime-web`
package) executes the model.

- Project: <https://github.com/microsoft/onnxruntime>
- Licence: MIT — Copyright (c) Microsoft Corporation

Its binaries are served from the application itself rather than from a content
delivery network, so nothing is fetched from a third party at run time.
