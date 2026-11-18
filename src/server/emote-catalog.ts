import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  EmoteCatalog as CatalogState,
  EmoteGroup,
} from '../shared/contracts.js';
import type { Store } from './db.js';

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const urlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !!url.hostname &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, '表情图片必须使用 HTTPS 地址');
const itemSchema = z
  .object({ id: idSchema.optional(), url: urlSchema })
  .strict();
const groupSchema = z
  .object({
    id: idSchema.optional(),
    label: z.string().trim().min(1).max(40),
    items: z.array(itemSchema).max(250),
  })
  .strict();
const saveSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    groups: z.array(groupSchema).max(20),
  })
  .strict();

export class EmoteConflictError extends Error {}

export class EmoteCatalog {
  private state: CatalogState;
  private activeIds: Set<string>;

  constructor(private db: Store) {
    this.state = this.read();
    this.activeIds = this.ids(this.state);
  }

  private read(): CatalogState {
    const row = this.db.sql
      .prepare(
        'SELECT revision,enabled,groups_json AS groupsJson FROM emote_catalog WHERE id=1',
      )
      .get() as { revision: number; enabled: number; groupsJson: string };
    return {
      revision: row.revision,
      enabled: Boolean(row.enabled),
      groups: JSON.parse(row.groupsJson) as EmoteGroup[],
    };
  }

  private ids(state: CatalogState): Set<string> {
    return new Set(
      state.groups.flatMap((group) => group.items.map((item) => item.id)),
    );
  }

  get(): CatalogState {
    return structuredClone(this.state);
  }

  allows(id: string): boolean {
    return this.state.enabled && this.activeIds.has(id);
  }

  save(input: unknown): CatalogState {
    const parsed = saveSchema.parse(input);
    if (parsed.groups.reduce((sum, group) => sum + group.items.length, 0) > 500)
      throw new z.ZodError([]);

    const next = this.db.sql.transaction(() => {
      const before = this.read();
      if (parsed.revision !== before.revision)
        throw new EmoteConflictError('表情配置已被修改，请刷新后重试');
      const oldGroups = new Set(before.groups.map((group) => group.id));
      const oldItems = this.ids(before);
      const groupIds = new Set<string>();
      const itemIds = new Set<string>();
      const groups = parsed.groups.map((group) => {
        if (group.id && !oldGroups.has(group.id)) throw new z.ZodError([]);
        const groupId = group.id ?? `g_${randomUUID()}`;
        if (groupIds.has(groupId)) throw new z.ZodError([]);
        groupIds.add(groupId);
        return {
          id: groupId,
          label: group.label,
          items: group.items.map((item) => {
            if (item.id && !oldItems.has(item.id)) throw new z.ZodError([]);
            const itemId = item.id ?? `e_${randomUUID()}`;
            if (itemIds.has(itemId)) throw new z.ZodError([]);
            itemIds.add(itemId);
            return { id: itemId, url: item.url };
          }),
        };
      });
      const changed = this.db.sql
        .prepare(
          'UPDATE emote_catalog SET revision=revision+1,enabled=?,groups_json=? WHERE id=1 AND revision=?',
        )
        .run(
          parsed.enabled ? 1 : 0,
          JSON.stringify(groups),
          parsed.revision,
        ).changes;
      if (!changed)
        throw new EmoteConflictError('表情配置已被修改，请刷新后重试');
      return { revision: before.revision + 1, enabled: parsed.enabled, groups };
    })();
    this.state = next;
    this.activeIds = this.ids(next);
    return this.get();
  }
}
