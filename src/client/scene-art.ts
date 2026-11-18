import { Container, Graphics } from 'pixi.js';
import { SCENE, stageSeatXs } from '../shared/contracts';
import type { EnvironmentId } from '../shared/environments';

const ink = 0x464c40;
const stagePalette = {
  cozy: {
    shadow: 0x79694d,
    front: 0xad805b,
    top: 0xc49b6c,
    seat: 0xb99168,
    detail: 0xd8b78b,
  },
  greenhouse: {
    shadow: 0x546452,
    front: 0x8e9e80,
    top: 0xc4cdac,
    seat: 0xa8b694,
    detail: 0xe3e7ce,
  },
  seaside: {
    shadow: 0x857257,
    front: 0xae846c,
    top: 0xd0ae87,
    seat: 0xbb9778,
    detail: 0xf1d9b5,
  },
  rooftop: {
    shadow: 0x26354d,
    front: 0x79828e,
    top: 0xb0b6bd,
    seat: 0x969eaa,
    detail: 0xe1d3b6,
  },
} satisfies Record<
  EnvironmentId,
  { shadow: number; front: number; top: number; seat: number; detail: number }
>;

function rect(
  parent: Container,
  x: number,
  y: number,
  w: number,
  h: number,
  color: number,
  radius = 0,
) {
  const g = new Graphics().roundRect(x, y, w, h, radius).fill(color);
  parent.addChild(g);
  return g;
}
function line(parent: Container, points: number[], color = ink, width = 2) {
  const g = new Graphics().moveTo(points[0]!, points[1]!);
  for (let i = 2; i < points.length; i += 2)
    g.lineTo(points[i]!, points[i + 1]!);
  g.stroke({ color, width, cap: 'round', join: 'round' });
  parent.addChild(g);
  return g;
}
function contactShadow(
  parent: Container,
  x: number,
  y: number,
  width: number,
  height: number,
  color = 0x665540,
) {
  const shadow = new Graphics()
    .ellipse(x + 4, y + 2, width, height)
    .fill({ color, alpha: 0.06 })
    .ellipse(x, y, width * 0.72, height * 0.55)
    .fill({ color, alpha: 0.09 });
  parent.addChild(shadow);
}
function plant(
  parent: Container,
  x: number,
  y: number,
  scale = 1,
  leafShape: 'oval' | 'broad' | 'fine' = 'oval',
) {
  const pot = new Container();
  pot.position.set(x, y);
  pot.scale.set(scale);
  parent.addChild(pot);
  contactShadow(pot, 1, 28, 25, 5);
  if (leafShape === 'fine') {
    const leaves = new Graphics();
    for (let i = 0; i < 7; i++) {
      const tipX = (i - 3) * 12;
      const tipY = -60 - (3 - Math.abs(i - 3)) * 12;
      leaves
        .moveTo(-3, 0)
        .quadraticCurveTo(tipX * 0.3, tipY - 8, tipX, tipY)
        .quadraticCurveTo(tipX * 0.55, tipY * 0.6, 3, 0)
        .fill(i % 2 ? 0x8e9f75 : 0x6f8562);
    }
    pot.addChild(leaves);
  } else {
    line(pot, [0, 0, 0, -90], 0x65765a, 4);
    for (let i = 0; i < 5; i++) {
      const side = i % 2 ? 1 : -1;
      const leaf = new Graphics();
      if (leafShape === 'broad') {
        const y = -22 - i * 14;
        leaf
          .moveTo(0, y)
          .bezierCurveTo(
            side * 14,
            y - 28,
            side * 42,
            y - 25,
            side * 38,
            y - 13,
          )
          .quadraticCurveTo(side * 32, y + 6, 0, y)
          .fill(i % 2 ? 0x8e9f75 : 0x6f8562)
          .moveTo(2 * side, y - 1)
          .lineTo(29 * side, y - 15)
          .stroke({ color: 0x536d52, alpha: 0.25, width: 1 });
      } else {
        leaf
          .ellipse(side * 16, -28 - i * 14, 21, 9)
          .fill(i % 2 ? 0x8e9f75 : 0x6f8562);
        leaf.rotation = side * -0.5;
      }
      pot.addChild(leaf);
    }
  }
  pot.addChild(
    new Graphics()
      .poly([-24, -9, 24, -9, 17, 28, -17, 28])
      .fill(0xbb8064)
      .stroke({ color: 0x9d6b54, width: 2 }),
  );
  line(pot, [-25, -8, 25, -8], 0xd69d7c, 7);
}
export function drawStage(
  graphics: Graphics,
  capacity: number,
  environment: EnvironmentId,
) {
  const palette = stagePalette[environment];
  const xs = stageSeatXs(capacity);
  const left = xs[0]! - 81;
  const width = xs.at(-1)! + 81 - left;
  graphics
    .clear()
    .ellipse(SCENE.width / 2, 318, width / 2 - 3, 30)
    .fill({ color: palette.shadow, alpha: 0.12 })
    // A recessed plinth meets the floor without moving seats or their hit areas.
    .roundRect(left + 12, 310, width - 24, 23, 5)
    .fill(palette.shadow)
    .ellipse(SCENE.width / 2, 333, width / 2 - 13, 8)
    .fill({ color: palette.shadow, alpha: 0.12 })
    .roundRect(left, 270, width, 51, 10)
    .fill(palette.front)
    .roundRect(left, 266, width, 28, 10)
    .fill(palette.top);
  graphics
    .moveTo(left + 12, 297)
    .lineTo(left + width - 12, 297)
    .stroke({ color: palette.shadow, width: 1, alpha: 0.16 });
  if (environment === 'greenhouse' || environment === 'rooftop') {
    for (const x of xs) {
      graphics
        .moveTo(x - 36, 304)
        .lineTo(x + 36, 304)
        .stroke({ color: palette.detail, width: 1, alpha: 0.22 });
      if (environment === 'rooftop') {
        graphics
          .circle(x - 45, 305, 1.2)
          .circle(x + 45, 305, 1.2)
          .fill({ color: palette.shadow, alpha: 0.35 });
      }
    }
  }
  for (const x of xs) {
    graphics.roundRect(x - 37, 250, 74, 15, 7).fill(palette.seat);
    graphics
      .moveTo(x - 18, 279)
      .lineTo(x + 18, 279)
      .stroke({ color: palette.detail, width: 2, cap: 'round' });
  }
}
function cozyArt(stage: Container, stageArt: Graphics) {
  rect(stage, 0, 0, SCENE.width, SCENE.height, 0xf1ecdc);
  rect(stage, 0, 330, SCENE.width, 290, 0xdfc6a2);
  line(stage, [0, 329, SCENE.width, 329], 0xbda888, 3);
  for (let y = 365, row = 0; y < SCENE.height; y += 51, row++) {
    line(stage, [0, y, SCENE.width, y], 0xcdb38e, 1);
    for (let x = [35, 145, 85][row % 3]!; x < SCENE.width; x += 220)
      line(stage, [x, Math.max(330, y - 51), x, y], 0xcdb38e, 1);
  }
  // Four muted panes project down and right from the round window, on floor only.
  const sunlight = new Graphics();
  for (const pane of [
    [105, 341, 178, 341, 225, 375, 142, 375],
    [187, 341, 245, 341, 302, 375, 236, 375],
    [150, 383, 237, 383, 285, 417, 188, 417],
    [248, 383, 315, 383, 371, 417, 296, 417],
  ])
    sunlight.poly(pane).fill({ color: 0xfff2c9, alpha: 0.18 });
  stage.addChild(sunlight);
  rect(stage, 54, 46, 218, 195, 0xd6c5a5, 95);
  const windowView = new Container();
  stage.addChild(windowView);
  rect(windowView, 64, 55, 198, 176, 0xcbd9cc);
  rect(windowView, 64, 153, 198, 78, 0xb3c4ab);
  windowView.addChild(new Graphics().circle(211, 102, 20).fill(0xf7edc3));
  line(windowView, [163, 55, 163, 233], 0xe8dec6, 8);
  line(windowView, [64, 149, 260, 149], 0xe8dec6, 8);
  // Clip every interior element to the opening, preserving the frame outside.
  windowView.mask = rect(windowView, 64, 55, 198, 176, 0xffffff, 88);
  rect(stage, 51, 241, 226, 5, 0xb49b78, 3).alpha = 0.14;
  rect(stage, 47, 231, 231, 10, 0xc2a47c, 3);
  rect(stage, 974, 97, 184, 6, 0xb49b78, 3).alpha = 0.16;
  rect(stage, 970, 89, 188, 8, 0xb99a72, 3);
  rect(stage, 995, 52, 15, 37, 0xb67e61, 2);
  rect(stage, 1014, 43, 13, 46, 0x849879, 2);
  rect(stage, 1033, 59, 12, 30, 0xd0b278, 2);
  plant(stage, 1109, 63, 0.48, 'fine');
  plant(stage, 72, 300, 1.1);
  plant(stage, 1171, 314, 1.3, 'broad');
  // The stage and seat markers use the same coordinates as the server.
  stage.addChild(stageArt);
  contactShadow(stage, 620, 464, 307, 99);
  stage.addChild(new Graphics().ellipse(618, 454, 311, 102).fill(0xc4c7a6));
  stage.addChild(
    new Graphics()
      .ellipse(618, 454, 293, 88)
      .stroke({ color: 0xe4dfc3, width: 2 }),
  );
  stage.addChild(
    new Graphics()
      .ellipse(618, 454, 277, 78)
      .stroke({ color: 0xe4dfc3, width: 1 }),
  );
  const stitches = new Graphics();
  for (let i = 0; i < 64; i++) {
    const angle = (i / 64) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    stitches
      .moveTo(618 + dx * 299, 454 + dy * 94)
      .lineTo(618 + dx * 304, 454 + dy * 98);
  }
  stitches.stroke({ color: 0xe4dfc3, width: 1, alpha: 0.65 });
  stage.addChild(stitches);
  contactShadow(stage, 75, 530, 51, 9);
  rect(stage, 29, 429, 88, 101, 0xb88a62, 9);
  rect(stage, 34, 432, 78, 91, 0x555b48, 7);
  stage.addChild(
    new Graphics()
      .circle(73, 458, 14)
      .stroke({ color: 0xaeb398, width: 2 })
      .circle(73, 496, 20)
      .stroke({ color: 0xaeb398, width: 2 }),
  );
  contactShadow(stage, 1169, 504, 50, 8);
  rect(stage, 1127, 442, 84, 62, 0xd5b88c, 8);
  rect(stage, 1123, 438, 92, 12, 0xe3c99f, 5);
  const grain = new Graphics()
    .moveTo(1136, 461)
    .bezierCurveTo(1150, 457, 1160, 463, 1174, 460)
    .moveTo(1180, 461)
    .lineTo(1200, 461)
    .moveTo(1150, 487)
    .bezierCurveTo(1168, 484, 1177, 489, 1195, 486)
    .stroke({ color: 0xa98663, width: 1, alpha: 0.3 });
  stage.addChild(grain);
  rect(stage, 1157, 421, 22, 18, 0xf2ecda, 4);
  line(stage, [1179, 424, 1186, 424, 1186, 432, 1179, 432], 0xf2ecda, 3);
}

function greenhouseArt(room: Container, stage: Graphics) {
  rect(room, 0, 0, SCENE.width, SCENE.height, 0xe3ede5);
  // Distant foliage stays below the open central pane reserved for lyrics.
  const garden = new Graphics();
  for (let i = 0; i < 16; i++) {
    const x = i * 88 - 20;
    const center = x > 300 && x < 940;
    garden
      .ellipse(x, 294, 91, 68 + (i % 3) * 15)
      .fill(center ? 0xd0dbc4 : 0xc5d1b2);
    garden
      .ellipse(x + 30, 315, 70, 45 + (i % 4) * 9)
      .fill(center ? 0xc1d0b6 : 0xaabf9d);
  }
  room.addChild(garden);
  // Glass reflections stay inside the side panes, leaving the central view clear.
  const glass = new Graphics();
  for (const x of [222, 870]) {
    glass
      .poly([x, 94, x + 36, 83, x + 114, 190, x + 75, 190])
      .fill({ color: 0xfffdf0, alpha: 0.17 })
      .poly([x + 48, 90, x + 58, 87, x + 131, 190, x + 121, 190])
      .fill({ color: 0xfffdf0, alpha: 0.12 });
  }
  room.addChild(glass);
  rect(room, 0, 0, SCENE.width, 18, 0x8fa897);
  line(room, [0, 98, 370, 25, 870, 25, SCENE.width, 98], 0xa5b9a9, 9);
  line(room, [0, 164, 370, 48, 870, 48, SCENE.width, 164], 0xc3d1c2, 3);
  for (const x of [28, 394, 846, 1212]) {
    rect(room, x, 30, 8, 297, 0x9db2a1, 2);
    rect(room, x + 2, 31, 2, 291, 0xd2ddcc);
  }
  line(room, [0, 208, 398, 208], 0xb1c3af, 5);
  line(room, [842, 208, SCENE.width, 208], 0xb1c3af, 5);
  line(room, [0, 325, SCENE.width, 325], 0x879d86, 12);
  // Quiet limestone tiles leave the shared walking area unobstructed.
  rect(room, 0, 330, SCENE.width, 290, 0xe3e2cd);
  for (let y = 350; y < SCENE.height; y += 54) {
    line(room, [0, y, SCENE.width, y], 0xcdd0bb, 1);
    for (let x = ((y - 350) / 54) % 2 ? 85 : 0; x < SCENE.width; x += 170)
      line(room, [x, y, x, y + 54], 0xcdd0bb, 1);
  }
  room.addChild(
    new Graphics()
      .poly([219, 347, 286, 347, 367, 416, 285, 416])
      .poly([919, 347, 984, 347, 1062, 416, 984, 416])
      .fill({ color: 0xfff9dd, alpha: 0.18 }),
  );
  contactShadow(room, 122, 337, 94, 8, 0x546452);
  rect(room, 32, 285, 176, 29, 0xb7b49a, 5);
  rect(room, 42, 308, 9, 29, 0x919e84, 2);
  rect(room, 185, 308, 9, 29, 0x919e84, 2);
  plant(room, 64, 270, 0.8, 'broad');
  plant(room, 125, 280, 0.6);
  plant(room, 181, 271, 0.72, 'fine');
  plant(room, 1170, 302, 1.28);
  plant(room, 1210, 319, 0.62, 'fine');
  room.addChild(stage);
  // Hanging planters frame the glass, outside the lyrics and seating.
  for (const x of [124, 1116]) {
    line(room, [x - 21, 15, x - 17, 101, x + 17, 101, x + 21, 15], 0x9aab91, 2);
    const leaves = new Graphics();
    for (let i = 0; i < 7; i++)
      leaves
        .ellipse(x - 28 + i * 9, 99 + (i % 3) * 7, 13, 7)
        .fill(i % 2 ? 0x91aa78 : 0x728e67);
    room.addChild(leaves);
    rect(room, x - 24, 103, 48, 17, 0xbe9578, 7);
    line(room, [x + 16, 118, x + 22, 137, x + 17, 152], 0x809969, 3);
    const trailingLeaves = new Graphics();
    for (let i = 0; i < 4; i++) {
      trailingLeaves
        .ellipse(x + 17 + (i % 2 ? 7 : -2), 126 + i * 7, 6, 3.5)
        .fill(i % 2 ? 0x91aa78 : 0x728e67);
    }
    room.addChild(trailingLeaves);
  }
  plant(room, 49, 483, 0.87, 'broad');
  plant(room, 1193, 531, 0.94);
  contactShadow(room, 72, 587, 57, 8, 0x546452);
  rect(room, 21, 546, 97, 17, 0xa9b593, 4);
  rect(room, 28, 563, 8, 24, 0x8d9b7b, 2);
  rect(room, 102, 563, 8, 24, 0x8d9b7b, 2);
  contactShadow(room, 1153, 575, 23, 5, 0x546452);
  const wateringCan = new Graphics()
    .roundRect(1138, 550, 29, 24, 5)
    .fill(0x91a7a0)
    .poly([1139, 556, 1121, 548, 1121, 553, 1141, 566])
    .fill(0x91a7a0)
    .roundRect(1162, 551, 15, 18, 6)
    .stroke({ color: 0x91a7a0, width: 4 });
  room.addChild(wateringCan);
}

function seasideArt(room: Container, stage: Graphics) {
  rect(room, 0, 0, SCENE.width, SCENE.height, 0xf4d9c5);
  // A sunset vignette at the left leaves the lyric sky calm and uninterrupted.
  room.addChild(
    new Graphics().circle(181, 126, 62).fill({ color: 0xf9e5cc, alpha: 0.6 }),
  );
  room.addChild(new Graphics().circle(181, 126, 43).fill(0xffefcc));
  line(room, [49, 70, 100, 70], 0xf9e8d8, 6);
  line(room, [1078, 114, 1166, 114], 0xf9e8d8, 5);
  line(room, [1115, 127, 1194, 127], 0xf9e8d8, 3);
  rect(room, 0, 205, SCENE.width, 142, 0x9abec0);
  rect(room, 0, 205, SCENE.width, 33, 0xb3c9c4);
  line(room, [0, 205, SCENE.width, 205], 0xe9d7be, 2);
  // Short, static sunset reflections stay at the left of the lyric area.
  const reflections = new Graphics();
  for (let i = 0; i < 7; i++) {
    const halfWidth = 15 + i * 6;
    const x = 181 + (i % 2 ? 8 : -6);
    const y = 212 + i * 13;
    reflections
      .moveTo(x - halfWidth, y)
      .lineTo(x + halfWidth, y)
      .stroke({ color: 0xf7e3c3, alpha: 0.28 - i * 0.02, width: 2 });
  }
  room.addChild(reflections);
  for (let i = 0; i < 19; i++) {
    const x = (i * 157) % (SCENE.width - 20);
    const y = 220 + (i % 4) * 25;
    line(room, [x, y, x + 22 + (i % 3) * 17, y], 0xcde0d4, i % 2 ? 1 : 2);
  }
  const shore = new Graphics()
    .moveTo(0, 324)
    .bezierCurveTo(350, 300, 453, 348, 638, 325)
    .bezierCurveTo(842, 299, 957, 338, SCENE.width, 318)
    .lineTo(SCENE.width, SCENE.height)
    .lineTo(0, SCENE.height)
    .closePath()
    .fill(0xe4cfad);
  room.addChild(shore);
  // A narrow damp-sand band follows the same shoreline and recedes into dry sand.
  room.addChild(
    new Graphics()
      .moveTo(0, 324)
      .bezierCurveTo(350, 300, 453, 348, 638, 325)
      .bezierCurveTo(842, 299, 957, 338, SCENE.width, 318)
      .lineTo(SCENE.width, 331)
      .bezierCurveTo(957, 353, 842, 315, 638, 340)
      .bezierCurveTo(453, 363, 350, 315, 0, 338)
      .closePath()
      .fill({ color: 0xb9aa90, alpha: 0.19 }),
  );
  const foam = new Graphics()
    .moveTo(0, 324)
    .bezierCurveTo(350, 300, 453, 348, 638, 325)
    .bezierCurveTo(842, 299, 957, 338, SCENE.width, 318)
    .stroke({ color: 0xf7edd7, width: 5, cap: 'round' });
  room.addChild(foam);
  const wavelets = new Graphics();
  for (const [x, y, width] of [
    [110, 291, 77],
    [297, 305, 46],
    [891, 286, 64],
    [1048, 302, 93],
  ]) {
    wavelets
      .moveTo(x!, y!)
      .quadraticCurveTo(x! + width! / 2, y! - 4, x! + width!, y!)
      .stroke({ color: 0xf7edd7, alpha: 0.48, width: 2, cap: 'round' });
  }
  room.addChild(wavelets);
  room.addChild(
    new Graphics()
      .ellipse(626, 470, 300, 93)
      .fill({ color: 0xf0ddbc, alpha: 0.55 }),
  );
  room.addChild(stage);
  // A compact driftwood fence and palms live at the perimeter, not on the floor paths.
  for (const x of [27, 82, 1158, 1213]) {
    rect(room, x, 273, 9, 84, 0xb69e80, 4);
    rect(room, x - 2, 271, 13, 8, 0xcbb590, 3);
  }
  line(room, [30, 291, 86, 305], 0xd0ba94, 4);
  line(room, [1162, 305, 1217, 291], 0xd0ba94, 4);
  const palm = new Graphics()
    .moveTo(51, 315)
    .quadraticCurveTo(78, 240, 59, 161)
    .stroke({ color: 0xb19470, width: 12, cap: 'round' });
  room.addChild(palm);
  for (const [x, y, bendX, bendY] of [
    [4, 173, 23, 131],
    [133, 177, 101, 129],
    [15, 215, 14, 162],
    [122, 219, 112, 157],
    [55, 105, 33, 111],
  ]) {
    room.addChild(
      new Graphics()
        .moveTo(59, 161)
        .quadraticCurveTo(bendX!, bendY!, x!, y!)
        .quadraticCurveTo((x! + 59) / 2, y! - 1, 59, 161)
        .fill(0x8f9e79),
    );
  }
  // Right-hand deck chair and left-hand radio add scale without big foreground objects.
  contactShadow(room, 1164, 479, 42, 8, 0x857257);
  const chair = new Graphics()
    .poly([1149, 408, 1187, 408, 1177, 450, 1139, 450])
    .fill(0xf5e7cd)
    .poly([1159, 408, 1170, 408, 1160, 450, 1149, 450])
    .fill(0xc88d79);
  room.addChild(chair);
  line(room, [1145, 403, 1191, 403, 1180, 455, 1133, 455], 0xac8e6c, 4);
  line(room, [1142, 448, 1186, 479], 0xac8e6c, 4);
  line(room, [1179, 448, 1134, 479], 0xac8e6c, 4);
  contactShadow(room, 66, 479, 39, 7, 0x857257);
  rect(room, 31, 437, 65, 42, 0xb78466, 8);
  rect(room, 38, 443, 35, 29, 0x6c7c71, 5);
  room.addChild(
    new Graphics()
      .circle(84, 449, 4)
      .fill(0xf2d8b1)
      .circle(84, 464, 4)
      .fill(0xf2d8b1),
  );
  line(room, [47, 437, 47, 429, 79, 429, 79, 437], 0x907757, 3);
  const sandRipples = new Graphics();
  for (const [x, y, width] of [
    [143, 395, 51],
    [198, 510, 38],
    [97, 583, 58],
    [1003, 414, 49],
    [1051, 520, 35],
    [983, 581, 62],
  ]) {
    sandRipples
      .moveTo(x!, y!)
      .quadraticCurveTo(x! + width! / 2, y! - 4, x! + width!, y!)
      .stroke({ color: 0xbca684, alpha: 0.3, width: 1, cap: 'round' });
  }
  room.addChild(sandRipples);
  for (let i = 0; i < 22; i++) {
    const x = 22 + ((i * 193) % (SCENE.width - 50));
    const y = 374 + ((i * 71) % 230);
    line(room, [x, y, x + 4, y], 0xcbb891, 1);
  }
  for (const [x, y] of [
    [130, 553],
    [1105, 552],
    [1165, 595],
  ]) {
    room.addChild(new Graphics().ellipse(x!, y!, 9, 5).fill(0xf6e5ca));
    const shellLines = new Graphics();
    for (const offset of [-5, 0, 5]) {
      shellLines.moveTo(x! - 1, y! + 3).lineTo(x! + offset, y! - 3);
    }
    shellLines.stroke({ color: 0xd7b49a, width: 1, alpha: 0.65 });
    room.addChild(shellLines);
  }
}

function rooftopArt(room: Container, stage: Graphics) {
  rect(room, 0, 0, SCENE.width, SCENE.height, 0x303d56);
  // Keep the center sky free of stars, cables and silhouettes behind the lyrics.
  const stars = new Graphics();
  for (const [x, y, radius] of [
    [62, 72, 1.4],
    [138, 121, 1],
    [233, 77, 1.5],
    [88, 171, 1],
    [998, 152, 1.3],
    [1169, 84, 1.4],
    [1198, 176, 1],
    [940, 24, 1],
  ])
    stars.circle(x!, y!, radius!).fill(0xe3dfcb);
  room.addChild(stars);
  room.addChild(
    new Graphics().circle(1076, 100, 47).fill({ color: 0xd8dfd5, alpha: 0.05 }),
  );
  room.addChild(new Graphics().circle(1076, 100, 29).fill(0xf2e6c9));
  room.addChild(new Graphics().circle(1086, 90, 27).fill(0x303d56));
  const distantSkyline = new Graphics();
  for (let i = 0; i < 18; i++) {
    const x = i * 76 - 12;
    const top = 214 + ((i * 19) % 48);
    distantSkyline.rect(x, top, 56 + (i % 3) * 7, 331 - top).fill(0x3b4860);
  }
  room.addChild(distantSkyline);
  const skyline = new Graphics();
  for (let i = 0, x = -10; x < SCENE.width; i++) {
    const width = 38 + ((i * 17) % 39);
    const top = 233 + ((i * 29) % 53);
    skyline.rect(x, top, width, 331 - top).fill(i % 2 ? 0x46546b : 0x3c4961);
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 3; col++)
        if ((i + row * 2 + col) % 3 === 0)
          skyline
            .rect(x + 8 + col * 11, top + 12 + row * 18, 4, 6)
            .fill({ color: 0xe5c58c, alpha: 0.48 });
    x += width + 9 + (i % 3) * 5;
  }
  room.addChild(skyline);
  rect(room, 0, 330, SCENE.width, 290, 0xc9cdd0);
  rect(room, 0, 330, SCENE.width, 290, 0x62768d).alpha = 0.08;
  for (let y = 350; y < SCENE.height; y += 60) {
    line(room, [0, y, SCENE.width, y], 0xb3bcc4, 1);
    for (let x = ((y - 350) / 60) % 2 ? 105 : 0; x < SCENE.width; x += 210)
      line(room, [x, y, x, y + 60], 0xb3bcc4, 1);
  }
  const moonlight = new Graphics()
    .poly([1016, 344, 1060, 344, 990, 414, 935, 414])
    .poly([1076, 344, 1096, 344, 1025, 414, 1004, 414])
    .fill({ color: 0xe0e6e5, alpha: 0.13 });
  room.addChild(moonlight);
  rect(room, 0, 316, SCENE.width, 14, 0x758398);
  line(room, [0, 318, SCENE.width, 318], 0xabb6c0, 1).alpha = 0.4;
  line(room, [0, 270, SCENE.width, 270], 0x8f9cac, 5);
  for (let x = 24; x < SCENE.width; x += 68)
    line(room, [x, 271, x, 317], 0x7b899d, 3);
  // Warm lights hang high enough to leave the lyric wheel uninterrupted.
  const cable = new Graphics()
    .moveTo(0, 8)
    .quadraticCurveTo(SCENE.width / 2, 66, SCENE.width, 8)
    .stroke({ color: 0x7b817d, width: 2 });
  room.addChild(cable);
  for (let x = 35; x < SCENE.width; x += 77) {
    const t = x / SCENE.width;
    const y = 8 + 116 * t * (1 - t);
    line(room, [x, y, x, y + 6], 0x7b817d, 2);
    room.addChild(
      new Graphics()
        .circle(x, y + 10, 19)
        .fill({ color: 0xf4cc83, alpha: 0.025 })
        .circle(x, y + 10, 11)
        .fill({ color: 0xf4cc83, alpha: 0.08 })
        .circle(x, y + 10, 3.5)
        .fill(0xf5d69a),
    );
  }
  room.addChild(stage);
  // Planters and low lanterns flank the usable floor; cat/name backgrounds stay pale.
  for (const x of [48, 1192]) {
    contactShadow(room, x, 346, 33, 6, 0x26354d);
    plant(room, x, 315, 0.85, x === 48 ? 'fine' : 'broad');
    rect(room, x - 27, 307, 54, 39, 0x697a83, 6);
    rect(room, x - 29, 306, 58, 8, 0x879893, 3);
  }
  for (const [x, y] of [
    [48, 452],
    [1187, 489],
  ]) {
    room.addChild(
      new Graphics()
        .ellipse(x! + 5, y! + 6, 49, 17)
        .fill({ color: 0xf2d697, alpha: 0.06 })
        .ellipse(x!, y! + 5, 26, 10)
        .fill({ color: 0xf2d697, alpha: 0.2 }),
    );
    contactShadow(room, x!, y! + 2, 16, 5, 0x26354d);
    rect(room, x! - 12, y! - 35, 24, 37, 0x687783, 4);
    rect(room, x! - 7, y! - 29, 14, 24, 0xf5d69a, 2);
    line(room, [x!, y! - 28, x!, y! - 6], 0xc5a270, 1).alpha = 0.45;
    line(
      room,
      [x! - 5, y! - 35, x! - 5, y! - 43, x! + 5, y! - 43, x! + 5, y! - 35],
      0x687783,
      2,
    );
  }
  contactShadow(room, 1168, 594, 55, 7, 0x26354d);
  rect(room, 1116, 555, 99, 15, 0xa89482, 4);
  line(room, [1124, 560, 1206, 560], 0xd8be96, 1).alpha = 0.4;
  rect(room, 1125, 570, 7, 24, 0x78818c, 2);
  rect(room, 1199, 570, 7, 24, 0x78818c, 2);
  rect(room, 1129, 542, 38, 13, 0xd8be96, 5);
  line(room, [1136, 549, 1161, 549], 0xf0dcc0, 1).alpha = 0.6;
  plant(room, 42, 572, 0.65, 'fine');
}

/** Only static room art lives here. Cats, events and camera belong to RoomScene. */
export function createRoomArt(environment: EnvironmentId, capacity: number) {
  const root = new Container();
  root.eventMode = 'none';
  const stage = new Graphics();
  switch (environment) {
    case 'greenhouse':
      greenhouseArt(root, stage);
      break;
    case 'seaside':
      seasideArt(root, stage);
      break;
    case 'rooftop':
      rooftopArt(root, stage);
      break;
    default:
      cozyArt(root, stage);
  }
  drawStage(stage, capacity, environment);
  // Scenery can extend past the edges; contain zoom must keep its gray gutters.
  root.mask = rect(root, 0, 0, SCENE.width, SCENE.height, 0xffffff);
  return { root, stage };
}

/** Replace scenery alone; preserve the world's occupants, transforms and listeners. */
export function replaceRoomArt(
  world: Container,
  previous: ReturnType<typeof createRoomArt> | undefined,
  environment: EnvironmentId,
  capacity: number,
) {
  previous?.root.destroy({ children: true, context: true });
  const next = createRoomArt(environment, capacity);
  world.addChildAt(next.root, 0);
  return next;
}
