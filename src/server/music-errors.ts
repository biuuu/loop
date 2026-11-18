export type MusicPlaybackFailure = 'unavailable' | 'upstream' | 'timeout';

const messages: Record<MusicPlaybackFailure, string> = {
  unavailable: '这首歌暂无可播放地址',
  upstream: '网易云暂时无法访问',
  timeout: '播放地址解析超时',
};

export class MusicPlaybackError extends Error {
  constructor(public readonly kind: MusicPlaybackFailure) {
    super(messages[kind]);
    this.name = 'MusicPlaybackError';
  }
}
