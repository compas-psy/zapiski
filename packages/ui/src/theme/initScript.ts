import { APPEARANCE_STORAGE_KEY } from './types';

/**
 * Скрипт, который нужно вставить ИНЛАЙНОМ в <head> оболочки (apps/*) до любых
 * стилей и до первого кадра:
 *
 *   <script>{themeInitScript}</script>
 *
 * Он ставит data-theme/data-accent/... из сохранённого выбора пользователя
 * ещё до первой отрисовки — поэтому при запуске нет ни белой вспышки, ни
 * подмены темы после гидратации (DESIGN_TOKENS.md §4).
 *
 * Скрипт намеренно не импортирует ничего: он выполняется до загрузки бандла.
 */
export const themeInitScript = `(function(){try{
var K=${JSON.stringify(APPEARANCE_STORAGE_KEY)};
var T=["paper","graphite","ink"],A=["garnet","blueberry","slate"];
/* Отменённые имена — та же карта, что в types.ts: без неё выбранная руками
   светлая тема стала бы «системной» и вечером открылась тёмной. */
var LT={simpas:"paper"},LA={granite:"slate",dusk:"blueberry",heather:"blueberry"};
var s={};try{s=JSON.parse(localStorage.getItem(K)||"{}")||{}}catch(e){s={}}
var e=s.editor||{};
var dark=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;
var t=LT[s.theme]||s.theme;if(T.indexOf(t)<0)t=dark?"graphite":"paper";
var a=LA[s.accent]||s.accent;if(A.indexOf(a)<0)a="garnet";
var r=document.documentElement;
r.setAttribute("data-theme",t);
r.setAttribute("data-accent",a);
r.setAttribute("data-density",e.compact===true?"compact":"comfortable");
r.setAttribute("data-typeface",e.typeface==="serif"?"serif":"sans");
var fs=[14,15,16,18,20].indexOf(e.fontSize)<0?16:e.fontSize;
var lh=[1.45,1.65,1.85].indexOf(e.lineHeight)<0?1.65:e.lineHeight;
var cw=e.columnWidth===720?720:(e.columnWidth==="full"?"full":640);
r.style.setProperty("--editor-font-scale",String(fs/16));
r.style.setProperty("--editor-line-scale",String(lh/1.65));
r.style.setProperty("--editor-measure",cw==="full"?"none":(cw/16)+"rem");
}catch(err){}})();`;

/** Тег целиком — для шаблонизаторов, которым удобнее готовая строка. */
export const themeInitScriptTag = `<script>${themeInitScript}</script>`;
