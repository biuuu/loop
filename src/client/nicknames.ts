// Keep each segment within three Han characters: combinations stay at 4–6.
export const NICKNAME_PREFIXES = [
  '半糖',
  '慢半拍',
  '听歌',
  '瞌睡',
  '晒太阳',
  '月光',
  '追星',
  '晚风',
  '贪吃',
  '赖床',
  '窗边',
  '被窝',
  '耳机',
  '哼歌',
  '摇尾',
  '咕噜',
  '软软',
  '圆圆',
  '毛绒',
  '暖暖',
  '懒懒',
  '迷糊',
  '蹦跳',
  '安静',
  '害羞',
  '认真',
  '摸鱼',
  '初醒',
  '元气',
  '自在',
  '薄荷',
  '草莓',
  '海盐',
  '焦糖',
  '奶油',
  '桃子',
  '橘子',
  '抹茶',
  '桂花',
  '可可',
] as const;

export const NICKNAME_SUBJECTS = [
  '小橘猫',
  '小狸猫',
  '小白猫',
  '小黑猫',
  '小花猫',
  '小奶猫',
  '猫团子',
  '猫爪爪',
  '小毛球',
  '小尾巴',
  '布丁',
  '泡芙',
  '饭团',
  '年糕',
  '糯米团',
  '棉花糖',
  '小饼干',
  '小曲奇',
  '小蛋挞',
  '小面包',
  '可颂',
  '麻薯',
  '奶盖',
  '冰淇淋',
  '热可可',
  '小鱼干',
  '小月亮',
  '小星星',
  '小云朵',
  '小晚风',
  '小海浪',
  '小雨点',
  '小雪花',
  '蒲公英',
  '向日葵',
  '小唱片',
  '小音符',
  '八音盒',
  '口琴',
  '小铃铛',
] as const;

/** Uniformly pick a two-part suggestion, excluding the current name if present. */
export function randomNickname(current = ''): string {
  const name = current.trim();
  const subjectCount = NICKNAME_SUBJECTS.length;
  let previous = -1;
  for (let prefix = 0; prefix < NICKNAME_PREFIXES.length; prefix++) {
    const start = NICKNAME_PREFIXES[prefix]!;
    if (!name.startsWith(start)) continue;
    const subject = NICKNAME_SUBJECTS.findIndex((end) => start + end === name);
    if (subject >= 0) {
      previous = prefix * subjectCount + subject;
      break;
    }
  }
  const total = NICKNAME_PREFIXES.length * subjectCount;
  let index = Math.floor(Math.random() * (total - (previous >= 0 ? 1 : 0)));
  if (previous >= 0 && index >= previous) index++;
  return (
    NICKNAME_PREFIXES[Math.floor(index / subjectCount)]! +
    NICKNAME_SUBJECTS[index % subjectCount]!
  );
}
