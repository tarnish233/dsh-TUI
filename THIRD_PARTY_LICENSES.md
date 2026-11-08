# Third-party notices

## Pi TUI

The terminal framework is vendored from `@earendil-works/pi-tui` 1.5.0
(MIT), https://github.com/earendil-works/pi/tree/main/packages/tui. The vendored
source keeps this license; DSH-specific Editor/SelectList entry points are in
`src/input/pi-tui-seam.js`, not a pnpm patch.

MIT License
Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Native DSH integration dependencies

The application calls DeepSeek Harness public services and loads official preset
resources through its native plugin/composition APIs. DSH packages are native
host peers, not vendored implementations or a second model backend.

`@deepseek-ai/schemastery` 3.19.0 supplies native-compatible plugin configuration
validation, and `commander` 15.0.0 supplies the grammar used by DSH's public
`dsh-cmdline` adapter. Both are MIT licensed; their upstream notices remain in
the installed packages. No source from either package is copied or modified.

## sharp

`sharp` 0.35.5 (https://sharp.pixelplumbing.com), by Lovell Fuller and
contributors, is used only as an asynchronous display codec for image previews.
It does not own DSH attachment admission, persistence, model transport or vision
policy. No sharp source is copied or modified by this project.

Licensed under Apache License 2.0:
https://www.apache.org/licenses/LICENSE-2.0
The complete upstream license is retained in `node_modules/sharp/LICENSE`;
transitive native packages retain their own notices, including libvips licensing.

## pi-cc-extensions

Display conventions and palette values are adapted from
https://github.com/minuque/pi-cc-extensions. The tools grouping, Input/Output
preview and detail interaction reference version 1.0.14; the projection and
normalized hitboxes are project-owned components. No Pi Agent runtime/prototype
patches or write-tool overrides are imported.

MIT License
Copyright (c) 2026 minuque

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## pi-tool-display

The tools Diff layout approach (`src/ui/tool-diff.ts`) references
[MasuRii/pi-tool-display](https://github.com/MasuRii/pi-tool-display) at commit
`91cef7580078371f8dc49a8607222807ad6a424d`, through pi-cc-extensions. The
Copyright (c) MasuRii and pi-tool-display contributors / MIT notice is retained
in the source and reproduced in [the upstream attribution](docs/TOOLS-DIFF-ATTRIBUTION.md).
Only display/layout is reused: DSH supplies before/after facts; no Write tool,
file snapshot collection or execution is imported.

## agent_tui

Some layout, text, theme and dialog patterns are adapted from the local
MIT-licensed `/Users/fulei/workspace/agent_tui` project. Its README declares
MIT and the local files retain no additional copyright notice. This project
keeps its source attribution in the adapted modules.

## DeepSeek logo

The static startup logo is derived from the DeepSeek logo reference supplied by
the user (`assets/logo/reference/deepseek-logo.png`): the background badge is
removed, the blue silhouette is sampled into `assets/logo/grid.json`, and the
enclosed negative space is filled white. The runtime draws that grid with block
characters only; it does not embed or upload an image. Rendering uses our own
renderer plus Pi TUI's MIT-licensed public color/width helpers, not a third-party
art asset. The separate `assets/icon/dsh-tui.svg` and PNG application icons reuse
the approved grid with a white silhouette and a blue rounded-square background;
these are static distribution artwork, not terminal image uploads. The logo and
brand marks belong to DeepSeek; no endorsement is implied.

## Retired dsh-TUI pixel-whale notices

The following notices are retained as historical attribution only. Neither the
mascot modules/frames nor any image/PNG startup asset below is part of the
current runtime, which renders a static blue/white character grid. Their data
and composition were previously reused from
https://github.com/ccch1mneyyy/dsh-TUI, pinned at commit
`149a4162a0ec648ef077ac3f030ca728287b8305`:

- `src/components/whaleFrames.ts`
- `src/components/whaleLayers.ts`
- `src/components/Whale.tsx` (presentation/timing reference only)

The React/Ink/application wiring is not imported. Only the mascot's source data
and presentation helpers are adapted to our existing Pi TUI terminal renderer;
DSH, input and session behavior are unchanged. Source attribution is retained
in the adapted module.

MIT License

Copyright (c) 2026, chimney (ccch1mneyyy)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## dsh-ui-whale art and layer composition

The pixel art and independent layer composition in the dsh-TUI mascot originate
from https://github.com/lhh010/dsh-ui-whale (the upstream source attributes the
hand-drawn `dsh-ui-whale` frame set to `@lhh010`). Its BSD-3-Clause notice is
retained alongside the MIT notice for dsh-TUI's adaptation. License verified at
public commit `d5b4449b40e49a6e051d52d85693e5c36e543148`; the implementation
copied here is the dsh-TUI snapshot pinned above, not a second application or
plugin integration. No endorsement by either upstream author is implied.

BSD 3-Clause License

Copyright (c) 2026, lhh010

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

Other npm dependencies retain their own license/notice files in their packages.
