# Third-party notices

## NeteaseCloudMusicApiBackup

`src/server/netease-protocol.ts` and the endpoint parameters in `src/server/music.ts`
are adapted from the locally supplied NeteaseCloudMusicApiBackup 4.25.0
(`util/crypto.js`, `util/request.js`, `module/cloudsearch.js`,
`module/song_detail.js`, `module/song_url_v1.js`, `module/register_anonimous.js`,
`module/playlist_detail.js`, `module/playlist_track_all.js`, `module/lyric.js`).
The implementation uses Node's built-in crypto and Undici for HTTP, includes only
the required endpoints, and removes the separate Express service, global
temporary token files and audio forwarding. Anonymous identity stays in memory;
Undici honors the server's configured network proxy for metadata requests only.

Upstream license:

The MIT License (MIT)

Copyright (c) 2013-2022 Binaryify

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## Pixel Cat

`public/Cat/Cat.png` and `public/Cat/Cat.aseprite` are from
[Pixel Cat by Shadow28144](https://shadow28144.itch.io/pixel-cat).
