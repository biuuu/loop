-- Fresh databases start at schema version 11.

CREATE TABLE guests (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  pointer INTEGER NOT NULL DEFAULT 0,
  coat TEXT NOT NULL DEFAULT 'orange'
    CHECK (coat IN ('orange', 'gray', 'cream', 'black', 'white', 'pure_black', 'pure_white')),
  pattern TEXT NOT NULL DEFAULT 'solid'
    CHECK (pattern IN ('solid', 'socks', 'tabby')),
  playlist_revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE playlist (
  guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  track_json TEXT NOT NULL,
  PRIMARY KEY (guest_id, track_id)
);

CREATE TABLE auth_identities (
  user_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('email','github','google')),
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider,subject)
);
CREATE INDEX auth_identities_user ON auth_identities(user_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('temporary','email','github','google')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE email_challenges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('login','bind')),
  user_id TEXT REFERENCES guests(id) ON DELETE CASCADE,
  session_hash TEXT,
  code_hmac TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed INTEGER NOT NULL DEFAULT 0,
  ip TEXT NOT NULL
);
CREATE INDEX email_challenges_email ON email_challenges(email,created_at);
CREATE INDEX email_challenges_ip ON email_challenges(ip,created_at);

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL UNIQUE REFERENCES guests(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32),
  environment_id TEXT NOT NULL CHECK (environment_id IN ('cozy','greenhouse','seaside','rooftop')),
  join_policy TEXT NOT NULL DEFAULT 'open' CHECK (join_policy IN ('open','closed')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  stage_capacity INTEGER NOT NULL DEFAULT 6 CHECK (stage_capacity BETWEEN 1 AND 6)
);

CREATE TABLE room_bans (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id,user_id)
);

-- Public room addresses use sequential numbers; UUIDs remain internal IDs.
-- AUTOINCREMENT keeps previously allocated numbers from being reused.
CREATE TABLE room_numbers (
  number INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL UNIQUE REFERENCES rooms(id) ON DELETE CASCADE
);

CREATE TABLE emote_catalog (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  groups_json TEXT NOT NULL
);

INSERT INTO emote_catalog (id, revision, enabled, groups_json)
VALUES (1, 1, 1, json('
[
  {
    "id": "nahida",
    "label": "小草神",
    "items": [
      {"id": "nahida-1", "url": "https://img.nga.cn/attachments/mon_202301/11/i2Q2r-i3zaKaToS5k-5k.gif"},
      {"id": "nahida-2", "url": "https://img.nga.cn/attachments/mon_202301/11/i2Q2r-43g5KiToS5k-5k.gif"},
      {"id": "nahida-3", "url": "https://img.nga.cn/attachments/mon_202301/11/i2Q2r-b7ebKhToS5k-5k.gif"},
      {"id": "nahida-4", "url": "https://img.nga.cn/attachments/mon_202301/11/i2Q2r-j6cyKgToS5k-5k.gif"},
      {"id": "nahida-5", "url": "https://img.nga.cn/attachments/mon_202301/11/i2Q2r-4nc8KdToS5k-5k.gif"},
      {"id": "nahida-6", "url": "https://img.nga.cn/attachments/mon_202301/11/i2Q2r-d1b0KfToS5k-5k.gif"},
      {"id": "nahida-7", "url": "https://img.nga.cn/attachments/mon_202301/11/i2Q2r-l04xKfToS5k-5k.gif"},
      {"id": "nahida-8", "url": "https://img.nga.cn/attachments/mon_202301/11/i2Q2r-7sulKeToS5k-5k.gif"},
      {"id": "nahida-9", "url": "https://img.nga.cn/attachments/mon_202301/11/i2Q2r-f2f0KgToS5k-5k.gif"},
      {"id": "nahida-10", "url": "https://img.nga.cn/attachments/mon_202301/11/i2Q2r-qjtKfToS5k-5k.gif"},
      {"id": "nahida-11", "url": "https://img.nga.cn/attachments/mon_202301/11/i2Q2r-7x26KhToS5k-5k.gif"},
      {"id": "nahida-12", "url": "https://img.nga.cn/attachments/mon_202301/11/i2Q2r-f3o6KhToS5k-5k.gif"},
      {"id": "nahida-13", "url": "https://img.nga.cn/attachments/mon_202301/11/i2Q2r-12jbKdToS5k-5k.gif"},
      {"id": "nahida-14", "url": "https://img.nga.cn/attachments/mon_202301/11/i2Q2r-8aaeKeToS5k-5k.gif"},
      {"id": "nahida-15", "url": "https://img.nga.cn/attachments/mon_202301/11/i2Q2r-goj0KeToS5k-5k.gif"},
      {"id": "nahida-16", "url": "https://img.nga.cn/attachments/mon_202301/11/i2Q2r-47mdKfToS5k-5k.gif"}
    ]
  },
  {
    "id": "ys",
    "label": "原神",
    "items": [
      {"id": "ys-1", "url": "https://img-static.mihoyo.com/communityweb/upload/ee7bb800b0c90f66fa9e321cb6d8ee17.png"},
      {"id": "ys-2", "url": "https://img-static.mihoyo.com/communityweb/upload/fe198bb1523528c2b852d28626379a2a.png"},
      {"id": "ys-3", "url": "https://img-static.mihoyo.com/communityweb/upload/70b5b0c9543ee5080c6ae92fd2797892.png"},
      {"id": "ys-4", "url": "https://img-static.mihoyo.com/communityweb/upload/392df119e6bb2c758b5d8bf25e8d58a1.png"},
      {"id": "ys-5", "url": "https://img-static.mihoyo.com/communityweb/upload/6b88559cbba96a1fa965e5412736370d.png"},
      {"id": "ys-6", "url": "https://img-static.mihoyo.com/communityweb/upload/c6a13a33cc28af3f0dadac0631b07da0.png"},
      {"id": "ys-7", "url": "https://img-static.mihoyo.com/communityweb/upload/951272c9ce086ecb1baefd179f18973c.png"},
      {"id": "ys-8", "url": "https://img-static.mihoyo.com/communityweb/upload/74bce5dfdb7d0a3e5dfc267b9784b106.png"},
      {"id": "ys-9", "url": "https://img-static.mihoyo.com/communityweb/upload/94553133dd24e430b529dce156c5747f.png"},
      {"id": "ys-10", "url": "https://img-static.mihoyo.com/communityweb/upload/f7763e07de9cad339ce6adc3c8f5e807.png"},
      {"id": "ys-11", "url": "https://img-static.mihoyo.com/communityweb/upload/ad23f629a5b8d5f7b66843d785c98db8.png"},
      {"id": "ys-12", "url": "https://img-static.mihoyo.com/communityweb/upload/b62638ec63587a6719b36f00a334cb06.png"},
      {"id": "ys-13", "url": "https://img-static.mihoyo.com/communityweb/upload/60fc86d84ce87e01722fed13ff4d3bda.png"},
      {"id": "ys-14", "url": "https://img-static.mihoyo.com/communityweb/upload/c0fc7a39c2ca7876e5aa8839b6e1f507.png"},
      {"id": "ys-15", "url": "https://img-static.mihoyo.com/communityweb/upload/726f998f6a9c9a6979c2d199b5aa8d90.png"},
      {"id": "ys-16", "url": "https://img-static.mihoyo.com/communityweb/upload/3875cd40bec66e5effc04d4dd4e49526.png"},
      {"id": "ys-17", "url": "https://img-static.mihoyo.com/communityweb/upload/e52a3fa8fd52d7577293332d8c704d67.png"},
      {"id": "ys-18", "url": "https://img-static.mihoyo.com/communityweb/upload/6b72e22e82737bda6bccf29692bee918.png"},
      {"id": "ys-19", "url": "https://upload-bbs.miyoushe.com/upload/2022/12/21/ba1911eb23143adba655866736eb27e6_4869807662588667960.png"},
      {"id": "ys-20", "url": "https://upload-bbs.miyoushe.com/upload/2022/12/21/6ec2ab5ab672705dc0c65eac14921e81_1759251254730775278.png"},
      {"id": "ys-21", "url": "https://upload-bbs.miyoushe.com/upload/2022/12/21/eb81e5ee4f7c360e6e6c711c20a36fbb_5639520591044343819.png"},
      {"id": "ys-22", "url": "https://upload-bbs.miyoushe.com/upload/2022/12/21/a08ff16e41dba7fe269d66ce03778a87_315101471837464944.png"},
      {"id": "ys-23", "url": "https://upload-bbs.miyoushe.com/upload/2022/12/21/e6feb3e4a7f09e0f428d5edb0a1f0833_7699955911978901933.png"},
      {"id": "ys-24", "url": "https://upload-bbs.miyoushe.com/upload/2022/12/21/48ffdc5f0b6f8b42ce7a0bb61c31344e_8914672507658818744.png"},
      {"id": "ys-25", "url": "https://upload-bbs.miyoushe.com/upload/2022/12/21/a9cf59fe68ba5331b168122deccbf129_6006890631861912875.png"},
      {"id": "ys-26", "url": "https://upload-bbs.miyoushe.com/upload/2022/12/21/4c849038022047f17f5a09a048e6f0e3_161769615726031671.png"},
      {"id": "ys-27", "url": "https://upload-bbs.miyoushe.com/upload/2022/12/21/351194cc5392f2a2527e1096618deb29_3870969492131645929.png"},
      {"id": "ys-28", "url": "https://upload-bbs.miyoushe.com/upload/2022/12/21/d364cbf606b633be67a1536289347556_8458169816302857767.png"},
      {"id": "ys-29", "url": "https://upload-bbs.miyoushe.com/upload/2022/12/21/e28edcbb61ddd434045f140d3a1f9607_2840054327277455683.png"},
      {"id": "ys-30", "url": "https://upload-bbs.miyoushe.com/upload/2022/12/21/c7489b361dde5b57844cb53ca37a2b05_6397517332908173344.png"},
      {"id": "ys-31", "url": "https://upload-bbs.miyoushe.com/upload/2022/12/21/4e0198c22a46f520abea97e450405b12_705258926215932928.png"},
      {"id": "ys-32", "url": "https://upload-bbs.miyoushe.com/upload/2022/12/21/6bf4ba03d77560e797085eb691f40b91_4095837989954111024.png"},
      {"id": "ys-33", "url": "https://upload-bbs.miyoushe.com/upload/2022/12/21/3e0d3a0b4c9c3e075949f7f8010c322d_5693816029335153202.png"},
      {"id": "ys-34", "url": "https://upload-bbs.miyoushe.com/upload/2022/12/21/fc54df9ee5d9a9fbcfc5009f744b4f19_2142689310235023086.png"},
      {"id": "ys-35", "url": "https://upload-bbs.miyoushe.com/upload/2022/12/21/496b41d101eec4c792e82da91fc29daf_2136519103324822738.png"}
    ]
  },
  {
    "id": "imsc",
    "label": "闪耀色彩",
    "items": [
      {"id": "imsc-2", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-9h6dKcT8S2x-2g.png"},
      {"id": "imsc-3", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-brf3KhT8S2s-2g.png"},
      {"id": "imsc-4", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-ki6tKhT8S2s-2g.png"},
      {"id": "imsc-5", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-77piKeT8S2i-2g.png"},
      {"id": "imsc-6", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-fpreKiToS2x-2g.png"},
      {"id": "imsc-7", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-3cqxKiToS2x-2g.png"},
      {"id": "imsc-8", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-d9fpKmToS2x-2g.png"},
      {"id": "imsc-9", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-19pdKhToS2x-2g.png"},
      {"id": "imsc-10", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-ac3aKjToS2x-2g.png"},
      {"id": "imsc-11", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-jeogKlToS2x-2g.png"},
      {"id": "imsc-12", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-7q85KiToS2x-2g.png"},
      {"id": "imsc-13", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-4c9wKkToS2x-2g.png"},
      {"id": "imsc-14", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-68hvKjToS2x-2g.png"},
      {"id": "imsc-15", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-3l0vKkToS2x-2g.png"},
      {"id": "imsc-16", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-3pnhKlToS2x-2g.png"},
      {"id": "imsc-17", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-58edKiToS2x-2g.png"},
      {"id": "imsc-18", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-495sKhT8S2x-2g.png"},
      {"id": "imsc-19", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-4c2dKiToS2x-2g.png"},
      {"id": "imsc-20", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-6gulKjToS2x-2g.png"},
      {"id": "imsc-21", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-3p43KiToS2u-2g.png"},
      {"id": "imsc-22", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-48aqKhT8S2r-2g.png"},
      {"id": "imsc-23", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-3nsoKhT8S2u-2g.png"},
      {"id": "imsc-24", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-4035KhToS2k-2g.png"},
      {"id": "imsc-25", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-3z3uKiToS2x-2g.png"},
      {"id": "imsc-26", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-6armKhToS2v-2g.png"},
      {"id": "imsc-27", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-42wtKeT8S2o-2g.png"},
      {"id": "imsc-28", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-3o02KdT8S2l-2g.png"},
      {"id": "imsc-29", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-3gvrKdT8S2m-2g.png"},
      {"id": "imsc-30", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-3y0sKfT8S2w-2g.png"},
      {"id": "imsc-31", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-3hgrKgT8S2x-2g.png"},
      {"id": "imsc-32", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-68z4KgT8S2s-2g.png"},
      {"id": "imsc-33", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-3vizKhT8S2u-2g.png"},
      {"id": "imsc-34", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-5gsvKgT8S2x-2a.png"},
      {"id": "imsc-35", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-4d3hKgT8S2x-2b.png"},
      {"id": "imsc-36", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-4m0yKfT8S2s-2g.png"},
      {"id": "imsc-37", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-3vc1KhToS2x-29.png"},
      {"id": "imsc-38", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-6b6cKfT8S2q-2g.png"},
      {"id": "imsc-39", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-3m0hKgT8S2x-28.png"},
      {"id": "imsc-40", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-3j1sKgT8S2x-2g.png"},
      {"id": "imsc-41", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-2yxzKgT8S2x-2g.png"},
      {"id": "imsc-42", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-3zt7KdT8S2n-2g.png"},
      {"id": "imsc-43", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-3jmmKcT8S2x-2b.png"},
      {"id": "imsc-44", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-6iiyKeT8S2o-2g.png"},
      {"id": "imsc-45", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-mrjKfT8S2j-2g.png"},
      {"id": "imsc-46", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-a1cyKgT8S2p-2g.png"},
      {"id": "imsc-47", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-k37kKhToS2x-2g.png"},
      {"id": "imsc-48", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-82f4KgT8S2x-2c.png"},
      {"id": "imsc-49", "url": "https://img.nga.cn/attachments/mon_202102/27/-77rdlQj09-gdgnKhT8S2x-2g.png"}
    ]
  },
  {
    "id": "ac1",
    "label": "AC娘(v1)",
    "items": [
      {"id": "ac1-1", "url": "https://img4.nga.cn/ngabbs/post/smile/ac0.png"},
      {"id": "ac1-2", "url": "https://img4.nga.cn/ngabbs/post/smile/ac1.png"},
      {"id": "ac1-3", "url": "https://img4.nga.cn/ngabbs/post/smile/ac2.png"},
      {"id": "ac1-4", "url": "https://img4.nga.cn/ngabbs/post/smile/ac3.png"},
      {"id": "ac1-5", "url": "https://img4.nga.cn/ngabbs/post/smile/ac4.png"},
      {"id": "ac1-6", "url": "https://img4.nga.cn/ngabbs/post/smile/ac5.png"},
      {"id": "ac1-7", "url": "https://img4.nga.cn/ngabbs/post/smile/ac6.png"},
      {"id": "ac1-8", "url": "https://img4.nga.cn/ngabbs/post/smile/ac8.png"},
      {"id": "ac1-9", "url": "https://img4.nga.cn/ngabbs/post/smile/ac9.png"},
      {"id": "ac1-10", "url": "https://img4.nga.cn/ngabbs/post/smile/ac10.png"},
      {"id": "ac1-11", "url": "https://img4.nga.cn/ngabbs/post/smile/ac11.png"},
      {"id": "ac1-12", "url": "https://img4.nga.cn/ngabbs/post/smile/ac12.png"},
      {"id": "ac1-13", "url": "https://img4.nga.cn/ngabbs/post/smile/ac13.png"},
      {"id": "ac1-14", "url": "https://img4.nga.cn/ngabbs/post/smile/ac14.png"},
      {"id": "ac1-15", "url": "https://img4.nga.cn/ngabbs/post/smile/ac15.png"},
      {"id": "ac1-16", "url": "https://img4.nga.cn/ngabbs/post/smile/ac17.png"},
      {"id": "ac1-17", "url": "https://img4.nga.cn/ngabbs/post/smile/ac23.png"},
      {"id": "ac1-18", "url": "https://img4.nga.cn/ngabbs/post/smile/ac21.png"},
      {"id": "ac1-19", "url": "https://img4.nga.cn/ngabbs/post/smile/ac33.png"},
      {"id": "ac1-20", "url": "https://img4.nga.cn/ngabbs/post/smile/ac34.png"},
      {"id": "ac1-21", "url": "https://img4.nga.cn/ngabbs/post/smile/ac35.png"},
      {"id": "ac1-22", "url": "https://img4.nga.cn/ngabbs/post/smile/ac36.png"},
      {"id": "ac1-23", "url": "https://img4.nga.cn/ngabbs/post/smile/ac37.png"},
      {"id": "ac1-24", "url": "https://img4.nga.cn/ngabbs/post/smile/ac22.png"},
      {"id": "ac1-25", "url": "https://img4.nga.cn/ngabbs/post/smile/ac24.png"},
      {"id": "ac1-26", "url": "https://img4.nga.cn/ngabbs/post/smile/ac25.png"},
      {"id": "ac1-27", "url": "https://img4.nga.cn/ngabbs/post/smile/ac26.png"},
      {"id": "ac1-28", "url": "https://img4.nga.cn/ngabbs/post/smile/ac27.png"},
      {"id": "ac1-29", "url": "https://img4.nga.cn/ngabbs/post/smile/ac28.png"},
      {"id": "ac1-30", "url": "https://img4.nga.cn/ngabbs/post/smile/ac29.png"},
      {"id": "ac1-31", "url": "https://img4.nga.cn/ngabbs/post/smile/ac16.png"},
      {"id": "ac1-32", "url": "https://img4.nga.cn/ngabbs/post/smile/ac18.png"},
      {"id": "ac1-33", "url": "https://img4.nga.cn/ngabbs/post/smile/ac19.png"},
      {"id": "ac1-34", "url": "https://img4.nga.cn/ngabbs/post/smile/ac20.png"},
      {"id": "ac1-35", "url": "https://img4.nga.cn/ngabbs/post/smile/ac30.png"},
      {"id": "ac1-36", "url": "https://img4.nga.cn/ngabbs/post/smile/ac32.png"},
      {"id": "ac1-37", "url": "https://img4.nga.cn/ngabbs/post/smile/ac40.png"},
      {"id": "ac1-38", "url": "https://img4.nga.cn/ngabbs/post/smile/ac44.png"},
      {"id": "ac1-39", "url": "https://img4.nga.cn/ngabbs/post/smile/ac38.png"},
      {"id": "ac1-40", "url": "https://img4.nga.cn/ngabbs/post/smile/ac43.png"},
      {"id": "ac1-41", "url": "https://img4.nga.cn/ngabbs/post/smile/ac31.png"},
      {"id": "ac1-42", "url": "https://img4.nga.cn/ngabbs/post/smile/ac39.png"},
      {"id": "ac1-43", "url": "https://img4.nga.cn/ngabbs/post/smile/ac41.png"},
      {"id": "ac1-44", "url": "https://img4.nga.cn/ngabbs/post/smile/ac7.png"},
      {"id": "ac1-45", "url": "https://img4.nga.cn/ngabbs/post/smile/ac42.png"}
    ]
  },
  {
    "id": "ac2",
    "label": "AC娘(v2)",
    "items": [
      {"id": "ac2-1", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_02.png"},
      {"id": "ac2-2", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_05.png"},
      {"id": "ac2-3", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_03.png"},
      {"id": "ac2-4", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_04.png"},
      {"id": "ac2-5", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_07.png"},
      {"id": "ac2-6", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_08.png"},
      {"id": "ac2-7", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_09.png"},
      {"id": "ac2-8", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_10.png"},
      {"id": "ac2-9", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_14.png"},
      {"id": "ac2-10", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_16.png"},
      {"id": "ac2-11", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_15.png"},
      {"id": "ac2-12", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_17.png"},
      {"id": "ac2-13", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_21.png"},
      {"id": "ac2-14", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_23.png"},
      {"id": "ac2-15", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_24.png"},
      {"id": "ac2-16", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_25.png"},
      {"id": "ac2-17", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_27.png"},
      {"id": "ac2-18", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_28.png"},
      {"id": "ac2-19", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_30.png"},
      {"id": "ac2-20", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_31.png"},
      {"id": "ac2-21", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_32.png"},
      {"id": "ac2-22", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_33.png"},
      {"id": "ac2-23", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_36.png"},
      {"id": "ac2-24", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_51.png"},
      {"id": "ac2-25", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_53.png"},
      {"id": "ac2-26", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_54.png"},
      {"id": "ac2-27", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_55.png"},
      {"id": "ac2-28", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_47.png"},
      {"id": "ac2-29", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_48.png"},
      {"id": "ac2-30", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_45.png"},
      {"id": "ac2-31", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_49.png"},
      {"id": "ac2-32", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_18.png"},
      {"id": "ac2-33", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_19.png"},
      {"id": "ac2-34", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_52.png"},
      {"id": "ac2-35", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_26.png"},
      {"id": "ac2-36", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_11.png"},
      {"id": "ac2-37", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_12.png"},
      {"id": "ac2-38", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_13.png"},
      {"id": "ac2-39", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_20.png"},
      {"id": "ac2-40", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_22.png"},
      {"id": "ac2-41", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_42.png"},
      {"id": "ac2-42", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_37.png"},
      {"id": "ac2-43", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_38.png"},
      {"id": "ac2-44", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_39.png"},
      {"id": "ac2-45", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_41.png"},
      {"id": "ac2-46", "url": "https://img4.nga.cn/ngabbs/post/smile/a2_40.png"}
    ]
  }
]
'));
