<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onBeforeUnmount,
  ref,
  watch,
} from 'vue';
import LyricsPanel from './LyricsPanel.vue';
import { replaceRoomArt, drawStage } from './scene-art';
import { environmentPreset } from '../shared/environments';
import {
  Application,
  Assets,
  CanvasSource,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  Texture,
} from 'pixi.js';
import {
  CAT_ANIMATIONS,
  CAT_CELL_SIZE,
  CAT_IDLE_UP_COLUMN,
  CAT_SCALE,
  catFrame,
  catActivity,
  type CatActivity,
  type CatAnimation,
} from './cat-sprite';
import { CAT_PACKED_ROWS, createAppearanceSheet } from './cat-appearance';
import {
  catAppearanceKey,
  DEFAULT_CAT_APPEARANCE,
  type CatAppearance,
} from '../shared/appearance';
import { House, Minus, Plus, Palette, LogOut, UserX } from '@lucide/vue';
import { useRoom } from './room';
import { createRemoteMovement, remoteFrameUser } from './remote-movement';
import { activeDjPlayback, DJ_NOTE_COUNT, djNotePose } from './dj-notes';
import {
  DEFAULT_STAGE_CAPACITY,
  SCENE,
  stageSeatXs,
  type Participant,
} from '../shared/contracts';
import { emoteUrl } from './emote-catalog';
import { createScenePinchZoom } from './scene-pinch-zoom';

import {
  clampZoom,
  DEFAULT_ZOOM,
  MAX_ZOOM,
  minZoom,
  floorTarget,
  sceneCamera,
  audienceCamera,
  stageCamera,
  easeCamera,
  reframeCamera,
  stageSeatAt,
  worldToScreen,
  type Bounds,
} from './scene-camera';

const props = defineProps<{ interactionDisabled?: boolean }>();
const emit = defineEmits<{
  'request-join': [];
  'request-leave': [];
  'request-appearance': [];
  'self-menu-open': [];
}>();
const room = useRoom();
const zoom = ref(DEFAULT_ZOOM);
const zoomControlsVisible = ref(false);
let zoomControlsTimer: ReturnType<typeof setTimeout> | undefined;
let zoomControlsHovered = false;
let zoomControlsFocused = false;
function revealZoomControls() {
  zoomControlsVisible.value = true;
  clearTimeout(zoomControlsTimer);
  if (!zoomControlsHovered && !zoomControlsFocused)
    zoomControlsTimer = setTimeout(() => {
      zoomControlsVisible.value = false;
    }, 3000);
}
function zoomControlsHover(hovered: boolean) {
  zoomControlsHovered = hovered;
  revealZoomControls();
}
function zoomControlsPointerDown() {
  zoomControlsFocused = false;
  revealZoomControls();
}
function zoomControlsFocusIn(event: FocusEvent) {
  zoomControlsFocused =
    event.target instanceof HTMLElement &&
    event.target.matches(':focus-visible');
  revealZoomControls();
}
function zoomControlsFocusOut(event: FocusEvent) {
  if (
    event.currentTarget instanceof HTMLElement &&
    event.relatedTarget instanceof Node &&
    event.currentTarget.contains(event.relatedTarget)
  )
    return;
  zoomControlsFocused = false;
  revealZoomControls();
}
const camera = ref(sceneCamera(SCENE.width, SCENE.height, DEFAULT_ZOOM));
const viewport = ref<{ width: number; height: number }>({
  width: SCENE.width,
  height: SCENE.height,
});
let cameraViewport: { width: number; height: number } = {
  width: SCENE.width,
  height: SCENE.height,
};
const minimumZoom = computed(() =>
  minZoom(viewport.value.width, viewport.value.height),
);
let updateCamera: ((deltaMs?: number) => void) | undefined;
let sceneInput: AbortController | undefined;
const pinch = createScenePinchZoom();
watch(
  () => props.interactionDisabled,
  (disabled) => {
    if (disabled) pinch.interrupt();
  },
  { flush: 'sync' },
);
const blocked = computed(
  () =>
    props.interactionDisabled ||
    room.stagePending ||
    room.connection !== 'connected' ||
    !room.me,
);
const isOwner = computed(
  () => !!room.guest && room.roomInfo?.ownerId === room.guest.id,
);
const stageCapacity = computed(
  () => room.snapshot?.stageCapacity ?? DEFAULT_STAGE_CAPACITY,
);
const environment = computed(() =>
  environmentPreset(
    room.roomInfo?.environmentId ?? room.snapshot?.room?.environmentId,
  ),
);
const stageCount = computed(() => room.snapshot?.stage.length ?? 0);
const joinControl = computed(() => {
  // Keep one join button visible when a narrow viewport crops the queue tail.
  for (const x of stageSeatXs(stageCapacity.value).slice(stageCount.value)) {
    const point = worldToScreen({ x, y: 237 }, camera.value);
    if (
      point.x >= 0 &&
      point.x <= viewport.value.width &&
      point.y >= 0 &&
      point.y <= viewport.value.height
    )
      return point;
  }
  return null;
});
function requestJoin() {
  if (blocked.value || room.onStage || stageCount.value >= stageCapacity.value)
    return;
  emit('request-join');
}
function changeZoom(value: number) {
  revealZoomControls();
  zoom.value = clampZoom(value, viewport.value.width, viewport.value.height);
  updateCamera?.();
}

const host = ref<HTMLDivElement>();
const selfMenu = ref<HTMLDivElement>();
const kickButton = ref<HTMLButtonElement>();
const menuPosition = ref<{ x: number; y: number } | null>(null);
const menuTargetId = ref<string | null>(null);
const confirmingKick = ref(false);
const menuUser = computed(() =>
  room.snapshot?.users.find((user) => user.id === menuTargetId.value),
);
const menuIsSelf = computed(() => menuTargetId.value === room.guest?.id);
function closeCatMenu() {
  menuPosition.value = null;
  menuTargetId.value = null;
  confirmingKick.value = false;
}
async function openCatMenu(userId: string, clientX: number, clientY: number) {
  if (
    blocked.value ||
    !host.value ||
    !room.snapshot?.users.some((user) => user.id === userId) ||
    (userId !== room.guest?.id && !isOwner.value)
  )
    return;
  if (userId === room.guest?.id) emit('self-menu-open');
  const bounds = host.value.getBoundingClientRect();
  const anchor = { x: clientX - bounds.left, y: clientY - bounds.top };
  menuTargetId.value = userId;
  confirmingKick.value = false;
  menuPosition.value = anchor;
  await nextTick();
  if (!menuPosition.value || !selfMenu.value) return;
  menuPosition.value = {
    x: Math.max(
      8,
      Math.min(anchor.x, bounds.width - selfMenu.value.offsetWidth - 8),
    ),
    y: Math.max(
      8,
      Math.min(anchor.y, bounds.height - selfMenu.value.offsetHeight - 8),
    ),
  };
  selfMenu.value
    .querySelector<HTMLButtonElement>('button')
    ?.focus({ preventScroll: true });
}
function dismissOnOutsideCatMenu(event: PointerEvent | FocusEvent) {
  const menu = selfMenu.value;
  if (menu && event.target instanceof Node && !menu.contains(event.target))
    closeCatMenu();
}
function escapeSelfMenu(event: KeyboardEvent) {
  if (menuPosition.value && event.key === 'Escape') {
    event.preventDefault();
    closeCatMenu();
  }
}
function selfMenuAction(action: 'appearance' | 'leave') {
  closeCatMenu();
  if (blocked.value) return;
  if (action === 'appearance') emit('request-appearance');
  else if (room.onStage) emit('request-leave');
}
async function setKickConfirmation(confirming: boolean) {
  confirmingKick.value = confirming;
  await nextTick();
  kickButton.value?.focus({ preventScroll: true });
}
async function moderateMenu(action: 'stage:remove' | 'member:kick') {
  const target = menuUser.value;
  if (
    blocked.value ||
    !isOwner.value ||
    !target ||
    target.id === room.guest?.id ||
    (action === 'stage:remove' && target.seat === null)
  ) {
    closeCatMenu();
    return;
  }
  if (action === 'member:kick' && !confirmingKick.value) {
    await setKickConfirmation(true);
    return;
  }
  closeCatMenu();
  await room.moderate(action, target.id);
}
watch(
  [blocked, () => room.guest?.id, () => room.roomId, viewport],
  closeCatMenu,
);
watch([menuUser, isOwner], ([user, owner]) => {
  if (menuTargetId.value && (!user || (!menuIsSelf.value && !owner)))
    closeCatMenu();
});
const unavailable = ref(false);
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
let app: Application | undefined;
let observer: ResizeObserver | undefined;
let overlayObserver: ResizeObserver | undefined;
let disposed = false;
let artWorld: Container | undefined;
let scenery: ReturnType<typeof replaceRoomArt> | undefined;
function rebuildRoomArt() {
  if (!artWorld || disposed) return;
  scenery = replaceRoomArt(
    artWorld,
    scenery,
    environment.value.id,
    stageCapacity.value,
  );
}
watch(() => environment.value.id, rebuildRoomArt);
watch(stageCapacity, () => {
  if (scenery)
    drawStage(scenery.stage, stageCapacity.value, environment.value.id);
});
const ink = 0x464c40;
const catTextures = new Map<string, Texture>();
const appearanceSheets = new Map<string, Texture>();
let originalCatImage: CanvasImageSource | undefined;
const emoteImages = new Map<string, HTMLImageElement>();
const failedEmoteUrls = new Set<string>();
function clearEmoteImages() {
  for (const image of emoteImages.values()) image.parentElement?.remove();
  emoteImages.clear();
}
function appearanceTexture(
  appearance: CatAppearance | undefined,
  animation: CatAnimation,
  column: number,
) {
  const preset = appearance ?? DEFAULT_CAT_APPEARANCE;
  const key = catAppearanceKey(preset);
  if (!appearanceSheets.has(key)) {
    const canvas = createAppearanceSheet(originalCatImage!, preset);
    const sheet = new Texture({
      source: new CanvasSource({ resource: canvas, scaleMode: 'nearest' }),
    });
    appearanceSheets.set(key, sheet);
    for (const [name, sequence] of Object.entries(CAT_ANIMATIONS)) {
      for (let frame = 0; frame < sequence.frames; frame++) {
        catTextures.set(
          `${key}:${name}:${frame}`,
          new Texture({
            source: sheet.source,
            frame: new Rectangle(
              frame * CAT_CELL_SIZE,
              CAT_PACKED_ROWS[name as CatAnimation] * CAT_CELL_SIZE,
              CAT_CELL_SIZE,
              CAT_CELL_SIZE,
            ),
          }),
        );
      }
    }
  }
  return catTextures.get(`${key}:${animation}:${column}`)!;
}
function disposeCatTextures() {
  // Release generated frame views and canvases; Assets retains the original image.
  for (const texture of catTextures.values()) texture.destroy(false);
  catTextures.clear();
  for (const sheet of appearanceSheets.values()) sheet.destroy(true);
  appearanceSheets.clear();
  originalCatImage = undefined;
}
const cats = new Map<
  string,
  {
    root: Container;
    body: Sprite;
    label: Text;
    notes: { layer: Container; glyphs: Graphics[] };
    fullLabel: string;
    facingRight: boolean;
    activity?: CatActivity;
    remoteMovement: ReturnType<typeof createRemoteMovement>;
  }
>();
// The sprite's transparent 64px cell is much larger than its visible pixels.
// Keep one stable envelope across all poses so idle animation cannot pan the view.
const catVisualBounds: Bounds = {
  left: -58,
  top: -78,
  right: 58,
  bottom: 30,
};
let safeArea: Bounds = { left: 18, top: 18, right: 982, bottom: 602 };
function measureSafeArea() {
  if (!host.value) return;
  const rect = host.value.getBoundingClientRect();
  const shell = host.value.closest('.in-room');
  const header = shell?.querySelector('.room-header')?.getBoundingClientRect();
  const dock = shell?.querySelector('.room-dock')?.getBoundingClientRect();
  const side = Math.min(28, Math.max(14, rect.width * 0.03));
  const top = Math.min(
    rect.height * 0.4,
    Math.max(16, header ? header.bottom - rect.top + 12 : 16),
  );
  const bottom = Math.min(
    rect.height - 8,
    Math.max(top + 48, dock ? dock.top - rect.top - 12 : rect.height - 16),
  );
  safeArea = {
    left: side,
    top,
    right: Math.max(side + 1, rect.width - side),
    bottom,
  };
}

function makeCat(user: Participant) {
  const root = new Container();
  // Only the local cat and an owner's guests become interactive in the ticker.
  root.eventMode = 'none';
  root.hitArea = new Rectangle(-45, -60, 90, 72);
  root.on('pointertap', (event) => {
    event.stopPropagation();
    if (pinch.suppressesTap(event)) return;
    void openCatMenu(user.id, event.clientX, event.clientY);
  });
  root.addChild(
    new Graphics().ellipse(0, -1, 23, 5).fill({ color: 0x5d5845, alpha: 0.12 }),
  );
  const notes = {
    layer: new Container(),
    glyphs: [] as Graphics[],
  };
  notes.layer.visible = false;
  notes.layer.eventMode = 'none';
  root.addChild(notes.layer);
  const body = new Sprite(
    appearanceTexture(user.appearance, 'idle', CAT_IDLE_UP_COLUMN),
  );
  body.pivot.set(32, CAT_ANIMATIONS.idle.footY);
  body.scale.set(CAT_SCALE);
  root.addChild(body);
  const label = new Text({
    text: user.nickname,
    resolution: 1,
    style: {
      fontFamily: 'sans-serif',
      fontSize: 13,
      fill: ink,
      fontWeight: '600',
      stroke: { color: 0xfff9e9, width: 2, join: 'round' },
    },
  });
  label.anchor.set(0.5, 0);
  label.y = 10;
  root.addChild(label);
  return {
    root,
    body,
    label,
    notes,
    fullLabel: '',
    facingRight: false,
    remoteMovement: createRemoteMovement(),
  };
}
function makeDjNote(index: number) {
  const colors = [0xb29458, 0x72938a, 0xb7806b];
  const glyph = new Graphics();
  const color = colors[index % colors.length]!;
  glyph.ellipse(0, 0, 3.5, 2.3).fill(color);
  if (index % 3 === 1) {
    glyph.ellipse(9, -2, 3.5, 2.3).fill(color);
    glyph
      .moveTo(2.5, 0)
      .lineTo(2.5, -12)
      .lineTo(11.5, -14)
      .lineTo(11.5, -2)
      .stroke({ color, width: 1.8, cap: 'round', join: 'round' });
    glyph.moveTo(2.5, -9).lineTo(11.5, -11).stroke({ color, width: 1.8 });
  } else {
    glyph
      .moveTo(2.5, 0)
      .lineTo(2.5, -13)
      .stroke({ color, width: 1.8, cap: 'round' });
    glyph
      .moveTo(2.5, -13)
      .bezierCurveTo(4, -10, 10, -10, 6.5, -5)
      .stroke({ color, width: 2.1, cap: 'round' });
  }
  return glyph;
}
onMounted(async () => {
  try {
    const instance = new Application();
    app = instance;
    await instance.init({
      width: SCENE.width,
      height: SCENE.height,
      antialias: true,
      backgroundAlpha: 0,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });
    if (disposed) {
      instance.destroy(true, { children: true, context: true });
      app = undefined;
      return;
    }
    const sheet = await Assets.load<Texture>('/Cat/Cat.png');
    if (disposed) return;
    originalCatImage = sheet.source.resource as CanvasImageSource;
    host.value!.appendChild(instance.canvas);
    const world = new Container();
    instance.stage.addChild(world);
    artWorld = world;
    rebuildRoomArt();
    const occupants = new Container();
    occupants.sortableChildren = true;
    world.addChild(occupants);
    world.eventMode = 'static';
    world.hitArea = {
      contains: (x: number, y: number) =>
        x >= 0 && x <= SCENE.width && y >= 0 && y <= SCENE.height,
    };
    world.on('pointertap', (event) => {
      if (blocked.value || pinch.suppressesTap(event)) return;
      const p = event.getLocalPosition(world);
      if (p.x < 0 || p.x > SCENE.width || p.y < 0 || p.y > SCENE.height) return;
      const seat = stageSeatAt(p, stageCapacity.value);
      if (seat !== null) {
        if (seat >= stageCount.value) requestJoin();
        return;
      }
      const target = floorTarget(p);
      if (!target) return;
      if (!room.onStage) room.move(target.x, target.y);
    });
    updateCamera = (deltaMs = 0) => {
      const localCat = room.guest && cats.get(room.guest.id);
      const { width, height } = viewport.value;
      const base = sceneCamera(width, height, zoom.value);
      const current =
        camera.value.scale === base.scale &&
        cameraViewport.width === width &&
        cameraViewport.height === height
          ? camera.value
          : reframeCamera(
              camera.value,
              cameraViewport.width,
              cameraViewport.height,
              width,
              height,
              zoom.value,
            );
      const target =
        room.onStage && localCat
          ? stageCamera(
              width,
              height,
              zoom.value,
              localCat.root.position,
              catVisualBounds,
              safeArea,
            )
          : localCat
            ? audienceCamera(
                width,
                height,
                zoom.value,
                localCat.root.position,
                current,
                safeArea,
              )
            : base;
      const next = easeCamera(
        current,
        target,
        deltaMs,
        motionPreference.matches,
      );
      cameraViewport = { ...viewport.value };
      world.scale.set(next.scale);
      world.position.set(next.x, next.y);
      // Keep world proportions; rasterize glyphs densely enough for their actual
      // device-pixel size. Integer tiers avoid rebuilding textures on every zoom step.
      const textResolution = Math.max(
        1,
        Math.ceil(next.scale * instance.renderer.resolution),
      );
      for (const cat of cats.values()) {
        if (cat.label.resolution !== textResolution)
          cat.label.resolution = textResolution;
      }
      if (
        next.x !== camera.value.x ||
        next.y !== camera.value.y ||
        next.scale !== camera.value.scale
      )
        camera.value = next;
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (props.interactionDisabled) return;
      const delta =
        event.deltaY *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? viewport.value.height
            : 1);
      changeZoom(
        zoom.value * Math.exp(-Math.max(-120, Math.min(120, delta)) * 0.0015),
      );
    };
    sceneInput = new AbortController();
    const passive = { passive: true, signal: sceneInput.signal };
    instance.canvas.addEventListener('wheel', wheel, {
      passive: false,
      signal: sceneInput.signal,
    });
    instance.canvas.addEventListener(
      'pointerdown',
      (event) => pinch.begin(event, Boolean(props.interactionDisabled)),
      passive,
    );
    instance.canvas.addEventListener(
      'pointermove',
      (event) => {
        if (props.interactionDisabled) return;
        const nextZoom = pinch.move(event, zoom.value);
        if (nextZoom !== undefined) changeZoom(nextZoom);
      },
      passive,
    );
    // Pixi dispatches pointertap during window capture, before document capture.
    const capture = { ...passive, capture: true };
    document.addEventListener(
      'pointerup',
      (event) => pinch.end(event),
      capture,
    );
    document.addEventListener(
      'pointercancel',
      (event) => pinch.end(event, true),
      capture,
    );
    const resize = () => {
      if (!host.value || disposed) return;
      const width = Math.max(1, host.value.clientWidth);
      const height = Math.max(1, host.value.clientHeight);
      viewport.value = { width, height };
      zoom.value = clampZoom(zoom.value, width, height);
      instance.renderer.resize(width, height);
      measureSafeArea();
      updateCamera?.();
    };
    observer = new ResizeObserver(resize);
    observer.observe(host.value!);
    overlayObserver = new ResizeObserver(measureSafeArea);
    const shell = host.value!.closest('.in-room');
    for (const selector of ['.room-header', '.room-dock']) {
      const overlay = shell?.querySelector(selector);
      if (overlay) overlayObserver.observe(overlay);
    }
    resize();
    instance.ticker.add(() => {
      const localNow = Date.now();
      const now = localNow + room.offset;
      const users = (room.snapshot?.users || []).map((user) =>
        user.id === room.guest?.id ? room.renderParticipant(user, now) : user,
      );
      for (const [id, cat] of cats)
        if (!users.some((user) => user.id === id)) {
          cat.root.destroy({ children: true });
          cats.delete(id);
        }
      for (const user of users) {
        let cat = cats.get(user.id);
        if (!cat) {
          cat = makeCat(user);
          cats.set(user.id, cat);
          occupants.addChild(cat.root);
        }
        const canOpenMenu = user.id === room.guest?.id || isOwner.value;
        cat.root.eventMode = canOpenMenu ? 'static' : 'none';
        cat.root.cursor = canOpenMenu ? 'pointer' : 'default';
        const t =
          user.durationMs > 0
            ? Math.max(
                0,
                Math.min(1, (now - user.movingSince) / user.durationMs),
              )
            : 1;
        const remote =
          user.id !== room.guest?.id
            ? cat.remoteMovement.view(user, now)
            : undefined;
        const displayUser = remote ? remoteFrameUser(user, remote, now) : user;
        cat.root.position.set(
          remote ? remote.x : user.x + (user.targetX - user.x) * t,
          remote ? remote.y : user.y + (user.targetY - user.y) * t,
        );
        cat.root.zIndex = cat.root.y;
        if (displayUser.facingRight !== undefined)
          cat.facingRight = displayUser.facingRight;
        else if (
          displayUser.durationMs > 0 &&
          displayUser.targetX !== displayUser.x
        )
          cat.facingRight = displayUser.targetX > displayUser.x;
        const emote = room.emoteFor(user.id, localNow);
        cat.activity = catActivity(
          cat.activity,
          user,
          now,
          room.snapshot?.serverTime,
          emote?.receivedAt,
        );
        const frame = catFrame(
          displayUser,
          now,
          motionPreference.matches,
          cat.facingRight,
          cat.activity.inactiveSince,
          remote?.walkStartedAt,
        );
        cat.body.texture = appearanceTexture(
          user.appearance,
          frame.animation,
          frame.column,
        );
        cat.body.pivot.y = frame.footY;
        cat.body.scale.set(frame.flipX ? -CAT_SCALE : CAT_SCALE, CAT_SCALE);
        cat.root.alpha = user.connected ? 1 : 0.45;
        const playing = activeDjPlayback(user.id, room.snapshot?.playback, now);
        cat.notes.layer.visible = playing !== null;
        if (playing) {
          // Allocate once, only when this cat first becomes the current DJ.
          if (!cat.notes.glyphs.length)
            for (let index = 0; index < DJ_NOTE_COUNT; index++) {
              const glyph = makeDjNote(index);
              cat.notes.glyphs.push(glyph);
              cat.notes.layer.addChild(glyph);
            }
          for (let index = 0; index < cat.notes.glyphs.length; index++) {
            const glyph = cat.notes.glyphs[index]!;
            const pose = djNotePose(
              index,
              now - playing.startedAt,
              motionPreference.matches,
            );
            glyph.visible = pose.alpha > 0;
            glyph.position.set(pose.x, pose.y);
            glyph.scale.set(pose.scale);
            glyph.rotation = pose.rotation;
            glyph.alpha = pose.alpha;
          }
        }
        const suffix = user.id === room.guest?.id ? ' · 你' : '';
        const fullLabel = `${user.nickname}${suffix}`;
        if (cat.fullLabel !== fullLabel) {
          cat.fullLabel = fullLabel;
          cat.label.text = fullLabel;
          if (cat.label.width > 136) {
            const characters = Array.from(user.nickname);
            while (characters.length > 1 && cat.label.width > 136) {
              characters.pop();
              cat.label.text = `${characters.join('')}…${suffix}`;
            }
          }
        }
        const url = emote?.url ?? (emote && emoteUrl(emote.id));
        let image = emoteImages.get(user.id);
        if (!url || failedEmoteUrls.has(url)) {
          if (image) {
            image.parentElement?.remove();
            emoteImages.delete(user.id);
          }
        } else {
          if (!image) {
            const bubble = document.createElement('div');
            bubble.className = 'scene-emote';
            bubble.setAttribute('aria-hidden', 'true');
            image = document.createElement('img');
            image.className = 'scene-emote-art';
            image.alt = '';
            image.onerror = () => {
              if (emoteImages.get(user.id) !== image) return;
              failedEmoteUrls.add(image!.src);
              bubble.remove();
              emoteImages.delete(user.id);
            };
            bubble.appendChild(image);
            host.value?.appendChild(bubble);
            emoteImages.set(user.id, image);
          }
          if (image.src !== url) image.src = url;
        }
      }
      // Follow the same interpolated position that was rendered, including in reduced motion.
      updateCamera?.(instance.ticker.deltaMS);
      for (const [id, image] of emoteImages) {
        const cat = cats.get(id);
        if (
          !cat ||
          !users.some((user) => user.id === id) ||
          !room.emoteFor(id, localNow)
        ) {
          image.parentElement?.remove();
          emoteImages.delete(id);
          continue;
        }
        const point = worldToScreen(
          { x: cat.root.x, y: cat.root.y - 61 },
          camera.value,
        );
        const bubble = image.parentElement;
        if (!bubble) continue;
        bubble.style.width = `${64 * camera.value.scale}px`;
        bubble.style.height = `${64 * camera.value.scale}px`;
        bubble.style.padding = `${4 * camera.value.scale}px`;
        bubble.style.left = `${point.x}px`;
        bubble.style.top = `${point.y}px`;
      }
    });
  } catch {
    observer?.disconnect();
    overlayObserver?.disconnect();
    sceneInput?.abort();
    updateCamera = undefined;
    if (app?.renderer) app.destroy(true, { children: true, context: true });
    app = undefined;
    artWorld = undefined;
    scenery = undefined;
    cats.clear();
    disposeCatTextures();
    clearEmoteImages();
    if (!disposed) unavailable.value = true;
  }
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', dismissOnOutsideCatMenu, true);
  document.removeEventListener('focusin', dismissOnOutsideCatMenu, true);
  document.removeEventListener('keydown', escapeSelfMenu);
  disposed = true;
  clearTimeout(zoomControlsTimer);
  observer?.disconnect();
  overlayObserver?.disconnect();
  sceneInput?.abort();
  updateCamera = undefined;
  if (app?.renderer) app.destroy(true, { children: true, context: true });
  app = undefined;
  artWorld = undefined;
  scenery = undefined;
  cats.clear();
  disposeCatTextures();
  clearEmoteImages();
});
onMounted(() => {
  document.addEventListener('pointerdown', dismissOnOutsideCatMenu, true);
  // Safari can blur a focused button before a different button receives its click.
  document.addEventListener('focusin', dismissOnOutsideCatMenu, true);
  document.addEventListener('keydown', escapeSelfMenu);
});
</script>

<template>
  <div
    class="room-canvas"
    ref="host"
    :data-environment="environment.id"
    :data-camera-x="camera.x"
    :data-camera-y="camera.y"
    :data-camera-scale="camera.scale"
    role="group"
    :aria-label="`共享猫咪${environment.name}。点击自己的小猫换花色或下台；房主可点击其他小猫管理成员。点击地面移动，点击空位上台，双指捏合或使用视野按钮缩放。`"
  >
    <template v-if="!unavailable">
      <LyricsPanel :camera="camera" />
      <div
        v-if="menuPosition"
        ref="selfMenu"
        class="self-cat-menu"
        role="dialog"
        :aria-label="
          menuIsSelf ? '我的小猫' : `${menuUser?.nickname ?? '成员'}的操作`
        "
        :style="{ left: `${menuPosition.x}px`, top: `${menuPosition.y}px` }"
        @pointerdown.stop
        @click.stop
      >
        <button v-if="menuIsSelf" @click="selfMenuAction('appearance')">
          <Palette aria-hidden="true" />换个花色
        </button>
        <button
          v-if="menuIsSelf && room.onStage"
          @click="selfMenuAction('leave')"
        >
          <LogOut aria-hidden="true" />离开舞台
        </button>
        <template v-if="!menuIsSelf && menuUser && isOwner">
          <button
            v-if="menuUser.seat !== null && !confirmingKick"
            @click="moderateMenu('stage:remove')"
          >
            <LogOut aria-hidden="true" />离开舞台
          </button>
          <p v-if="confirmingKick" class="cat-menu-confirm">
            将 {{ menuUser.nickname }} 移出房间？对方之后仍可进入。
          </p>
          <button ref="kickButton" @click="moderateMenu('member:kick')">
            <UserX aria-hidden="true" />{{
              confirmingKick ? '确认移出' : '移出房间'
            }}
          </button>
          <button v-if="confirmingKick" @click="setKickConfirmation(false)">
            取消
          </button>
        </template>
      </div>
      <button
        v-if="joinControl"
        class="scene-seat"
        :style="{
          left: `${joinControl.x}px`,
          top: `${joinControl.y}px`,
          '--seat-scale': camera.scale,
        }"
        aria-label="上台"
        :disabled="blocked || room.onStage"
        @click.stop="requestJoin"
      >
        <Plus aria-hidden="true" />
      </button>
      <div
        class="scene-zoom"
        :class="{ 'is-visible': zoomControlsVisible }"
        role="group"
        aria-label="房间视野"
        @pointerenter="zoomControlsHover(true)"
        @pointerleave="zoomControlsHover(false)"
        @focusin="zoomControlsFocusIn"
        @pointerdown="zoomControlsPointerDown"
        @focusout="zoomControlsFocusOut"
      >
        <button
          aria-label="缩小"
          title="缩小"
          :disabled="props.interactionDisabled || zoom <= minimumZoom"
          @click="changeZoom(zoom / 1.15)"
        >
          <Minus aria-hidden="true" />
        </button>
        <button
          aria-label="重置视野"
          title="重置视野"
          :disabled="props.interactionDisabled"
          @click="changeZoom(DEFAULT_ZOOM)"
        >
          {{ Math.round(zoom * 100) }}%
        </button>
        <button
          aria-label="放大"
          title="放大"
          :disabled="props.interactionDisabled || zoom >= MAX_ZOOM"
          @click="changeZoom(zoom * 1.15)"
        >
          <Plus aria-hidden="true" />
        </button>
      </div>
    </template>
    <div v-if="unavailable" class="scene-fallback">
      <span><House aria-hidden="true" /></span>
      <h2>欢迎来到{{ environment.name }}</h2>
      <p>此浏览器无法显示动画房间，你仍可使用下方名单、舞台和音乐功能。</p>
    </div>
  </div>
</template>

<style scoped>
.self-cat-menu {
  position: absolute;
  z-index: 4;
  min-width: 140px;
  padding: 5px;
  border: 1px solid #dedfce;
  border-radius: 12px;
  background: #faf8f2;
  box-shadow: 0 5px 20px #28301c25;
}
.self-cat-menu button {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  font-size: 13px;
}
.self-cat-menu button:hover,
.self-cat-menu button:focus-visible {
  background: #e9edde;
}
.cat-menu-confirm {
  max-width: 190px;
  margin: 4px 7px 6px;
  color: #5f6657;
  font-size: 12px;
  line-height: 1.5;
}
.room-canvas {
  background: #969b99;
}
.room-canvas[data-environment='rooftop'] {
  --lyrics-color: #f3e6cd;
  --lyrics-muted: #d4dcea;
  --lyrics-translation: #ddd5c7;
}
.scene-zoom {
  opacity: 0;
  pointer-events: none;
  transition: opacity 180ms ease;
  position: absolute;
  z-index: 2;
  top: calc(env(safe-area-inset-top, 0px) + 84px);
  right: max(20px, env(safe-area-inset-right, 0px));
  display: flex;
  gap: 3px;
  padding: 4px;
  border: 1px solid #ffffff9c;
  border-radius: 14px;
  background: #faf8eee6;
  box-shadow: 0 3px 14px #464c4012;
}
.scene-zoom.is-visible,
.scene-zoom:has(:focus-visible) {
  opacity: 1;
  pointer-events: auto;
}
@media (prefers-reduced-motion: reduce) {
  .scene-zoom {
    transition: none;
  }
}
.scene-zoom button {
  min-width: 36px;
  min-height: 36px;
  padding: 4px 8px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: #464c40;
  font-size: 14px;
}
.scene-zoom button:hover:not(:disabled) {
  background: #e3e7d7;
}
.scene-zoom button:disabled {
  opacity: 0.4;
}
.scene-seat {
  position: absolute;
  z-index: 1;
  transform: translate(-50%, -50%) scale(var(--seat-scale));
  width: 48px;
  height: 48px;
  min-height: 0;
  padding: 0;
  border: 1.5px dashed #fff9e6bb;
  border-radius: 50%;
  background: #fff8e92b;
  color: #fff9e6;
  font-size: 24px;
  box-shadow:
    0 2px 10px #28301c1f,
    inset 0 0 0 1px #28301c23;
  touch-action: manipulation;
}
.scene-seat:hover:not(:disabled),
.scene-seat:focus-visible {
  background: #faf4deeb;
  border-color: #6d7c57;
  color: #465b3d;
  outline: 2px solid #6d7c57;
  outline-offset: 3px;
}
.scene-seat:disabled {
  opacity: 0.3;
  cursor: default;
}
</style>
