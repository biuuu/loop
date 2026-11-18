import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Graphics } from 'pixi.js';
import { ENVIRONMENTS } from '../src/shared/environments';
import { stageSeatXs } from '../src/shared/contracts';
import {
  createRoomArt,
  drawStage,
  replaceRoomArt,
} from '../src/client/scene-art';

function descendants(root: Container): Container[] {
  return [root, ...root.children.flatMap(descendants)];
}

test('every environment builds vector scenery and releases all descendants and graphics contexts', () => {
  for (const preset of ENVIRONMENTS) {
    const art = createRoomArt(preset.id, 6);
    const children = descendants(art.root);
    const contexts = children
      .filter((child): child is Graphics => child instanceof Graphics)
      .map((child) => child.context);
    assert.ok(children.length > 20, preset.id);
    assert.ok(children.length < 250, preset.id);
    assert.equal(art.root.eventMode, 'none');
    assert.equal(art.stage.parent, art.root);
    assert.ok(art.root.mask);
    art.root.destroy({ children: true, context: true });
    assert.ok(
      children.every((child) => child.destroyed),
      preset.id,
    );
    assert.ok(
      contexts.every((context) => context.destroyed),
      preset.id,
    );
  }
});

test('resizing every stage follows shared seat geometry without replacing background or growing instructions', () => {
  for (const preset of ENVIRONMENTS) {
    const art = createRoomArt(preset.id, 6);
    const children = [...art.root.children];
    const context = art.stage.context;
    const sixSeatInstructions = context.instructions.length;
    for (const capacity of [1, 3, 6, 2, 5, 4, 6]) {
      drawStage(art.stage, capacity, preset.id);
      assert.deepEqual(art.root.children, children);
      assert.equal(art.stage.context, context);
      const xs = stageSeatXs(capacity);
      assert.equal(art.stage.bounds.minX, xs[0]! - 81);
      assert.equal(art.stage.bounds.maxX, xs.at(-1)! + 81);
      assert.equal(art.stage.bounds.minY, 250);
      assert.equal(art.stage.bounds.maxY, 348);
      assert.ok(context.instructions.length <= sixSeatInstructions);
    }
    assert.equal(context.instructions.length, sixSeatInstructions);
    art.root.destroy({ children: true, context: true });
  }
});

test('repeated theme switches release old art and retain occupants, camera and world listeners', () => {
  const world = new Container();
  const occupants = new Container();
  const cat = new Container();
  cat.position.set(440, 430);
  occupants.addChild(cat);
  world.addChild(occupants);
  world.position.set(-140, -30);
  world.scale.set(1.2);
  const listener = () => {};
  world.on('pointertap', listener);
  let art: ReturnType<typeof createRoomArt> | undefined;
  const counts = new Map<string, number>();
  for (let pass = 0; pass < 4; pass++) {
    for (const preset of ENVIRONMENTS) {
      const previous = art && descendants(art.root);
      const contexts = previous
        ?.filter((child): child is Graphics => child instanceof Graphics)
        .map((child) => child.context);
      art = replaceRoomArt(world, art, preset.id, 6);
      assert.deepEqual(world.children, [art.root, occupants]);
      assert.deepEqual(occupants.children, [cat]);
      assert.equal(cat.destroyed, false);
      assert.equal(cat.x, 440);
      assert.equal(cat.y, 430);
      assert.equal(world.x, -140);
      assert.equal(world.y, -30);
      assert.equal(world.scale.x, 1.2);
      assert.deepEqual(world.listeners('pointertap'), [listener]);
      if (previous) assert.ok(previous.every((child) => child.destroyed));
      if (contexts) assert.ok(contexts.every((context) => context.destroyed));
      const count = descendants(art.root).length;
      if (counts.has(preset.id)) assert.equal(count, counts.get(preset.id));
      else counts.set(preset.id, count);
    }
  }
  world.destroy({ children: true, context: true });
});
