import { shallowRef } from 'vue';
import type { EmoteCatalog } from '../shared/contracts';

export const emoteCatalog = shallowRef<EmoteCatalog | null>(null);
let loading: Promise<void> | undefined;

export function emoteUrl(id: string): string | undefined {
  for (const group of emoteCatalog.value?.groups ?? []) {
    const item = group.items.find((item) => item.id === id);
    if (item) return item.url;
  }
}

export function loadEmoteCatalog(force = false): Promise<void> {
  if (!force && emoteCatalog.value) return Promise.resolve();
  if (loading)
    return force
      ? loading.catch(() => {}).then(() => loadEmoteCatalog(true))
      : loading;
  loading = fetch('/api/emotes', { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error('表情列表暂时不可用');
      const catalog = (await response.json()) as EmoteCatalog;
      if (
        typeof catalog.enabled !== 'boolean' ||
        !Array.isArray(catalog.groups)
      )
        throw new Error('表情列表格式无效');
      emoteCatalog.value = catalog;
    })
    .finally(() => {
      loading = undefined;
    });
  return loading;
}
