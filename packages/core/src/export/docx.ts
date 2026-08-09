/**
 * Экспорт в DOCX (ТЗ §5.3). Собираем OOXML вручную и пакуем через `fflate`:
 * внешний конвертер потребовал бы либо сервер (нарушение local-first, ТЗ §2.1.2),
 * либо тяжёлую зависимость в каждой из трёх сборок.
 *
 * Поддержано: заголовки H1–H6, абзацы, жирный/курсив/зачёркнутый/выделение,
 * маркированные и нумерованные списки, чекбоксы, цитаты, код-блоки, таблицы GFM.
 */
import { zipSync } from 'fflate';
import type { Note } from '../contract.js';
import { parseBlocks, type Block, type Inline } from '../markdown/ast.js';
import { splitFrontmatter } from '../markdown/frontmatter.js';
import { utf8 } from '../util/bytes.js';
import { escapeHtml } from './html.js';

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  highlight?: boolean;
  code?: boolean;
  link?: boolean;
}

function runProperties(style: RunStyle): string {
  const parts: string[] = [];
  if (style.bold) parts.push('<w:b/>');
  if (style.italic) parts.push('<w:i/>');
  if (style.strike) parts.push('<w:strike/>');
  if (style.highlight) parts.push('<w:highlight w:val="yellow"/>');
  if (style.code) parts.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
  if (style.link) parts.push('<w:color w:val="2F6F5E"/><w:u w:val="single"/>');
  return parts.length === 0 ? '' : `<w:rPr>${parts.join('')}</w:rPr>`;
}

function runs(nodes: Inline[], style: RunStyle = {}): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += textRun(node.text, style);
        break;
      case 'strong':
        out += runs(node.children, { ...style, bold: true });
        break;
      case 'em':
        out += runs(node.children, { ...style, italic: true });
        break;
      case 'strike':
        out += runs(node.children, { ...style, strike: true });
        break;
      case 'mark':
        out += runs(node.children, { ...style, highlight: true });
        break;
      case 'code':
        out += textRun(node.text, { ...style, code: true });
        break;
      case 'link':
        out += runs(node.children, { ...style, link: true });
        break;
      case 'wiki':
        out += textRun(node.label === '' ? node.target : node.label, { ...style, link: true });
        break;
      case 'image':
        // Картинки в DOCX требуют media-части; для MVP выносим подпись.
        out += textRun(node.alt === '' ? node.src : node.alt, { ...style, italic: true });
        break;
      case 'footnote':
        out += textRun(`[${node.label}]`, { ...style });
        break;
      case 'break':
        out += '<w:r><w:br/></w:r>';
        break;
    }
  }
  return out;
}

function textRun(text: string, style: RunStyle): string {
  if (text === '') return '';
  return `<w:r>${runProperties(style)}<w:t xml:space="preserve">${escapeHtml(text)}</w:t></w:r>`;
}

function paragraph(content: string, properties = ''): string {
  return `<w:p>${properties}${content}</w:p>`;
}

function blocksToXml(blocks: Block[], quoted = false): string {
  const out: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        out.push(
          paragraph(runs(block.inline), `<w:pPr><w:pStyle w:val="Heading${Math.min(block.level, 6)}"/></w:pPr>`),
        );
        break;
      case 'paragraph':
        out.push(paragraph(runs(block.inline), quoted ? QUOTE_PR : ''));
        break;
      case 'code':
        for (const line of block.text.split('\n')) {
          out.push(paragraph(textRun(line, { code: true }), CODE_PR));
        }
        break;
      case 'quote':
        out.push(blocksToXml(block.blocks, true));
        break;
      case 'hr':
        out.push(paragraph('', '<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="D9D5CB"/></w:pBdr></w:pPr>'));
        break;
      case 'list':
        for (const item of block.items) {
          const prefix =
            item.checked === null ? [] : [{ type: 'text', text: item.checked ? '☑ ' : '☐ ' } as Inline];
          out.push(
            paragraph(
              runs([...prefix, ...item.inline]),
              `<w:pPr><w:numPr><w:ilvl w:val="${Math.min(item.level, 5)}"/><w:numId w:val="${
                block.ordered ? 2 : 1
              }"/></w:numPr></w:pPr>`,
            ),
          );
        }
        break;
      case 'table': {
        const header = `<w:tr>${block.header
          .map((cell) => `<w:tc>${TC_PR}${paragraph(runs(cell, { bold: true }))}</w:tc>`)
          .join('')}</w:tr>`;
        const rows = block.rows
          .map(
            (row) => `<w:tr>${row.map((cell) => `<w:tc>${TC_PR}${paragraph(runs(cell))}</w:tc>`).join('')}</w:tr>`,
          )
          .join('');
        out.push(`<w:tbl>${TBL_PR}${header}${rows}</w:tbl>`);
        break;
      }
      case 'footnoteDef':
        out.push(paragraph(runs([{ type: 'text', text: `${block.label}. ` }, ...block.inline]), QUOTE_PR));
        break;
    }
  }
  return out.join('');
}

const QUOTE_PR = '<w:pPr><w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="12" w:color="D9D5CB"/></w:pBdr></w:pPr>';
const CODE_PR = '<w:pPr><w:shd w:val="clear" w:fill="F1EFE9"/></w:pPr>';
const TC_PR = '<w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>';
const TBL_PR =
  '<w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>' +
  ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:color="D9D5CB"/>`)
    .join('') +
  '</w:tblBorders></w:tblPr>';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>
${[1, 2, 3, 4, 5, 6]
  .map(
    (level) =>
      `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:pPr><w:outlineLvl w:val="${
        level - 1
      }"/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI"/><w:b/><w:sz w:val="${
        Math.max(48 - level * 4, 24)
      }"/></w:rPr></w:style>`,
  )
  .join('')}
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>
${[0, 1, 2, 3, 4, 5]
  .map(
    (level) =>
      `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${
        360 * (level + 1)
      }" w:hanging="360"/></w:pPr></w:lvl>`,
  )
  .join('')}
</w:abstractNum>
<w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="hybridMultilevel"/>
${[0, 1, 2, 3, 4, 5]
  .map(
    (level) =>
      `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${
        level + 1
      }."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${360 * (level + 1)}" w:hanging="360"/></w:pPr></w:lvl>`,
  )
  .join('')}
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>
</w:numbering>`;

export function exportDocx(note: Note): Uint8Array {
  const body = splitFrontmatter(note.body).body;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${blocksToXml(parseBlocks(body))}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body>
</w:document>`;

  return zipSync(
    {
      '[Content_Types].xml': utf8(CONTENT_TYPES),
      '_rels/.rels': utf8(ROOT_RELS),
      'word/document.xml': utf8(document),
      'word/_rels/document.xml.rels': utf8(DOC_RELS),
      'word/styles.xml': utf8(STYLES),
      'word/numbering.xml': utf8(NUMBERING),
    },
    { level: 6 },
  );
}
