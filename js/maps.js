/**
 * maps.js —— 地图与图标注册表
 * 雷达图资源取自 scope.gg 战术板（CS2 官方雷达图），已本地化到 assets/ 目录。
 * 道具图标为项目自绘的矢量图（assets/icons/*.svg）：scope.gg 只提供柔和光晕
 * 风格的 PNG，放大后偏模糊，矢量图在任意缩放下都保持锐利。
 * 战术板坐标系：所有地图统一归一化到 1024 x 1024 的逻辑坐标空间，
 * 因此切换地图时对象坐标无需换算，雷达图按 1024 x 1024 铺满显示。
 */

const BOARD_SIZE = 1024;

/** 地图列表（默认顺序，用户可在界面上拖动调整，顺序存于浏览器本地） */
const MAPS = [
  { id: 'de_dust2',    name: '炙热沙城 II', en: 'Dust II',   img: 'assets/maps/de_dust2.png' },
  { id: 'de_mirage',   name: '荒漠迷城',  en: 'Mirage',     img: 'assets/maps/de_mirage.png' },
  { id: 'de_inferno',  name: '炼狱小镇',  en: 'Inferno',    img: 'assets/maps/de_inferno.png' },
  { id: 'de_nuke',     name: '核子危机',  en: 'Nuke',       img: 'assets/maps/de_nuke.png' },
  { id: 'de_overpass', name: '死亡游乐园', en: 'Overpass',  img: 'assets/maps/de_overpass.png' },
  { id: 'de_ancient',  name: '远古遗迹',  en: 'Ancient',    img: 'assets/maps/de_ancient.png' },
  { id: 'de_anubis',   name: '阿努比斯',  en: 'Anubis',     img: 'assets/maps/de_anubis.png' },
  { id: 'de_vertigo',  name: '殒命大厦',  en: 'Vertigo',    img: 'assets/maps/de_vertigo.png' },
  { id: 'de_train',    name: '列车停放站', en: 'Train',     img: 'assets/maps/de_train.png' },
  { id: 'de_cache',    name: '死城之谜',  en: 'Cache',      img: 'assets/maps/de_cache.png' }
];

const DEFAULT_MAP = 'de_mirage';

function getMap(id) {
  return MAPS.find(m => m.id === id) || MAPS.find(m => m.id === DEFAULT_MAP) || MAPS[0];
}

/* ---------------------------------------------------------
 * 地图顺序（支持拖动排序，顺序持久化到浏览器本地）
 * ------------------------------------------------------- */
const MAP_ORDER_KEY = 'cs2-tactics-board::mapOrder';
let mapOrderCache = null;

function defaultMapOrder() {
  return MAPS.map(m => m.id);
}

/** 读取本地顺序：过滤失效 id，并补上新增的地图（放在末尾） */
function loadMapOrder() {
  let stored = [];
  try { stored = JSON.parse(localStorage.getItem(MAP_ORDER_KEY) || '[]'); } catch (e) { stored = []; }
  if (!Array.isArray(stored)) stored = [];
  const known = MAPS.map(m => m.id);
  const kept = stored.filter(id => known.indexOf(id) >= 0);
  const rest = known.filter(id => kept.indexOf(id) < 0);
  return kept.concat(rest);
}

function getMapOrder() {
  if (!mapOrderCache) mapOrderCache = loadMapOrder();
  return mapOrderCache;
}

/** 按用户自定义顺序返回地图对象数组 */
function orderedMaps() {
  const byId = {};
  MAPS.forEach(m => { byId[m.id] = m; });
  return getMapOrder().map(id => byId[id]).filter(Boolean);
}

/**
 * 把 dragId 移动到 targetId 之前/之后
 * @returns {boolean} 顺序是否真的发生变化
 */
function moveMap(dragId, targetId, placeAfter) {
  const order = getMapOrder().slice();
  if (dragId === targetId) return false;
  const from = order.indexOf(dragId);
  if (from < 0 || order.indexOf(targetId) < 0) return false;
  order.splice(from, 1);
  const to = order.indexOf(targetId);
  order.splice(placeAfter ? to + 1 : to, 0, dragId);
  const changed = order.join(',') !== getMapOrder().join(',');
  mapOrderCache = order;
  try { localStorage.setItem(MAP_ORDER_KEY, JSON.stringify(order)); } catch (e) { /* 存储不可用则忽略 */ }
  return changed;
}

/** 恢复默认顺序 */
function resetMapOrder() {
  mapOrderCache = defaultMapOrder();
  try { localStorage.removeItem(MAP_ORDER_KEY); } catch (e) { /* 忽略 */ }
  return mapOrderCache;
}

/** 可用绘图颜色（贴近 scope.gg 战术板配色） */
const COLORS = [
  { value: '#E3D085', label: '默认黄' },
  { value: '#8AACDF', label: '队友蓝' },
  { value: '#FFFFFF', label: '白色' },
  { value: '#E04B4B', label: '危险红' },
  { value: '#F08B3C', label: '燃烧橙' },
  { value: '#4FD1A5', label: '薄荷绿' },
  { value: '#B27BFF', label: '紫色' },
  { value: '#2B3038', label: '深灰' }
];

/** 绘图工具 */
const TOOLS = [
  { id: 'move',   label: '移动',   svg: '<path d="M12 3v18M3 12h18"/><path d="m12 3 3 3-3-3-3 3M12 21l3-3-3 3-3-3M3 12l3-3-3 3 3 3M21 12l-3-3 3 3-3 3"/>' },
  { id: 'pen',    label: '画笔',   svg: '<path d="M3 21c3 0 4-2 6-4l9-9-3-3-9 9c-2 2-4 3-4 6"/><path d="m14 5 3 3"/>' },
  { id: 'line',   label: '直线',   svg: '<path d="M4 20 20 4"/>' },
  { id: 'arrow',  label: '箭头',   svg: '<path d="M4 20 20 4"/><path d="M13 4h7v7"/>' },
  { id: 'rect',   label: '矩形',   svg: '<rect x="4" y="4" width="16" height="16" rx="1"/>' },
  { id: 'circle', label: '圆形',   svg: '<circle cx="12" cy="12" r="8"/>' },
  { id: 'text',   label: '文字',   svg: '<path d="M5 5h14M12 5v14M9 19h6"/>' },
  { id: 'erase',  label: '橡皮',   svg: '<path d="M4 16 14 6a2 2 0 0 1 3 0l3 3a2 2 0 0 1 0 3l-8 8H6z"/><path d="M20 20H9"/>' }
];

/** 队员图标（CT 蓝 / T 黄，带编号） */
const TEAM_ITEMS = [
  { type: 'player', team: 'ct', color: '#8AACDF', label: 'CT 队员', index: 1 },
  { type: 'player', team: 'ct', color: '#8AACDF', label: 'CT 队员', index: 2 },
  { type: 'player', team: 'ct', color: '#8AACDF', label: 'CT 队员', index: 3 },
  { type: 'player', team: 'ct', color: '#8AACDF', label: 'CT 队员', index: 4 },
  { type: 'player', team: 'ct', color: '#8AACDF', label: 'CT 队员', index: 5 },
  { type: 'player', team: 't',  color: '#E3D085', label: 'T 队员',  index: 1 },
  { type: 'player', team: 't',  color: '#E3D085', label: 'T 队员',  index: 2 },
  { type: 'player', team: 't',  color: '#E3D085', label: 'T 队员',  index: 3 },
  { type: 'player', team: 't',  color: '#E3D085', label: 'T 队员',  index: 4 },
  { type: 'player', team: 't',  color: '#E3D085', label: 'T 队员',  index: 5 }
];

/** 道具图标（自绘矢量图，viewBox 0 0 64 64；size 为在 1024 逻辑坐标下的显示尺寸） */
const UTIL_ITEMS = [
  { type: 'smoke', label: '烟雾弹', icon: 'assets/icons/smoke.svg', size: 88 },
  { type: 'flash', label: '闪光弹', icon: 'assets/icons/flash.svg', size: 56 },
  { type: 'he',    label: '手雷',   icon: 'assets/icons/he.svg',    size: 52 },
  { type: 'fire',  label: '燃烧弹', icon: 'assets/icons/fire.svg',  size: 58 },
  { type: 'c4',    label: 'C4 炸弹', icon: 'assets/icons/c4.svg',   size: 56 }
];

/** 图标查找表 */
const ICON_BY_TYPE = Object.fromEntries(UTIL_ITEMS.map(i => [i.type, i]));
