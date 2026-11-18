const fs = require("fs");
const path = require("path");
const {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  TextRun,
} = require(path.join(process.env.TEMP, "harmony-docx-builder", "node_modules", "docx"));

const projectRoot = path.resolve(__dirname, "..");
const sourcePath = path.join(projectRoot, "docs", "specs", "harmony-ai-employee-evolution.md");
const outputPath = path.join(projectRoot, "docs", "specs", "harmony-ai-employee-evolution.docx");
const lines = fs.readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n").split("\n");
const children = [];

function text(value, options = {}) {
  return new TextRun({ text: value, font: "Microsoft YaHei", size: 22, ...options });
}

function addBody(value, options = {}) {
  children.push(new Paragraph({
    spacing: { after: 140, line: 360 },
    children: [text(value, options)],
  }));
}

function addImage(relativePath, caption) {
  const data = fs.readFileSync(path.resolve(path.dirname(sourcePath), relativePath));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 120, after: 60 },
    children: [new ImageRun({
      type: "png",
      data,
      transformation: { width: 620, height: 349 },
      altText: { title: caption, description: caption, name: "文章配图" },
    })],
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 180 },
    children: [text(caption, { size: 18, color: "667085", italics: true })],
  }));
}

let inMermaid = false;
let mermaidLines = [];
let numberedList = 0;

for (const rawLine of lines) {
  const line = rawLine.trim();
  if (line === "```mermaid") {
    inMermaid = true;
    mermaidLines = [];
    continue;
  }
  if (inMermaid) {
    if (line === "```") {
      children.push(new Paragraph({
        shading: { fill: "F3F7FF" },
        spacing: { before: 60, after: 60 },
        children: [text("AI 员工请求时序", { bold: true, color: "175CD3" })],
      }));
      for (const item of mermaidLines.filter(Boolean)) {
        children.push(new Paragraph({
          shading: { fill: "F3F7FF" },
          spacing: { after: 40 },
          indent: { left: 240, right: 240 },
          children: [new TextRun({ text: item, font: "Consolas", size: 18, color: "344054" })],
        }));
      }
      inMermaid = false;
    } else {
      mermaidLines.push(rawLine);
    }
    continue;
  }
  if (!line) {
    numberedList = 0;
    continue;
  }
  if (line.startsWith("# ")) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 260, after: 300 },
      children: [text(line.slice(2), { size: 38, bold: true, color: "0B1F5B" })],
    }));
    continue;
  }
  if (line.startsWith("## ")) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 280, after: 160 },
      children: [text(line.slice(3), { size: 28, bold: true, color: "0B4F9C" })],
    }));
    continue;
  }
  const imageMatch = line.match(/^!\[([^\]]+)\]\((.+)\)$/);
  if (imageMatch) {
    addImage(imageMatch[2], imageMatch[1]);
    continue;
  }
  if (line.startsWith("> ")) {
    children.push(new Paragraph({
      shading: { fill: "F4F8FF" },
      border: { left: { color: "2E90FA", space: 8, style: "single", size: 18 } },
      spacing: { after: 110, line: 340 },
      indent: { left: 180, right: 180 },
      children: [text(line.slice(2), { color: "344054" })],
    }));
    continue;
  }
  if (line.startsWith("- ")) {
    children.push(new Paragraph({
      numbering: { reference: "bullet-list", level: 0 },
      spacing: { after: 80, line: 340 },
      children: [text(line.slice(2))],
    }));
    continue;
  }
  const numberMatch = line.match(/^\d+\.\s+(.+)$/);
  if (numberMatch) {
    if (!numberedList) numberedList += 1;
    children.push(new Paragraph({
      numbering: { reference: `numbered-list-${numberedList}`, level: 0 },
      spacing: { after: 80, line: 340 },
      children: [text(numberMatch[1])],
    }));
    continue;
  }
  addBody(line.replace(/`([^`]+)`/g, "$1"));
}

const doc = new Document({
  styles: {
    default: { document: { run: { font: "Microsoft YaHei", size: 22, color: "1D2939" } } },
    paragraphStyles: [{
      id: "Heading1",
      name: "Heading 1",
      basedOn: "Normal",
      next: "Normal",
      quickFormat: true,
      run: { font: "Microsoft YaHei", size: 28, bold: true, color: "0B4F9C" },
      paragraph: { spacing: { before: 280, after: 160 }, outlineLevel: 0 },
    }],
  },
  numbering: {
    config: [
      {
        reference: "bullet-list",
        levels: [{
          level: 0,
          format: LevelFormat.BULLET,
          text: "•",
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 520, hanging: 260 } } },
        }],
      },
      {
        reference: "numbered-list-1",
        levels: [{
          level: 0,
          format: LevelFormat.DECIMAL,
          text: "%1.",
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 520, hanging: 260 } } },
        }],
      },
    ],
  },
  sections: [{
    properties: { page: { margin: { top: 860, right: 760, bottom: 760, left: 760 } } },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            text("鸿蒙迁移 AI 员工平台  ·  ", { size: 16, color: "98A2B3" }),
            new TextRun({ children: [PageNumber.CURRENT], font: "Microsoft YaHei", size: 16, color: "98A2B3" }),
          ],
        })],
      }),
    },
    children,
  }],
});

Packer.toBuffer(doc).then((buffer) => {
  fs.writeFileSync(outputPath, buffer);
  console.log(outputPath);
});
