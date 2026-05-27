import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from "docx";

function markdownLineToParagraph(line) {
  const trimmed = line.trim();
  if (!trimmed) return new Paragraph({ text: "" });

  if (trimmed.startsWith("### ")) {
    return new Paragraph({
      text: trimmed.slice(4),
      heading: HeadingLevel.HEADING_3
    });
  }

  if (trimmed.startsWith("## ")) {
    return new Paragraph({
      text: trimmed.slice(3),
      heading: HeadingLevel.HEADING_2
    });
  }

  if (trimmed.startsWith("# ")) {
    return new Paragraph({
      text: trimmed.slice(2),
      heading: HeadingLevel.HEADING_1
    });
  }

  if (trimmed.startsWith("- ")) {
    return new Paragraph({
      text: trimmed.slice(2),
      bullet: { level: 0 }
    });
  }

  if (/^\d+\.\s/.test(trimmed)) {
    return new Paragraph({ text: trimmed, spacing: { after: 120 } });
  }

  return new Paragraph({ text: trimmed });
}

function isMarkdownTableLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|");
}

function isTableDivider(line) {
  const normalized = line.replace(/\s/g, "");
  return /^\|:?-{3,}:?(\|:?-{3,}:?)+\|$/.test(normalized);
}

function parseTableCells(line) {
  return line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function markdownTableToDocxTable(lines) {
  const dataLines = lines.filter((line, idx) => !(idx === 1 && isTableDivider(line)));
  const rows = dataLines.map((line, rowIndex) => {
    const cells = parseTableCells(line);
    return new TableRow({
      children: cells.map((cell) =>
        new TableCell({
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text: cell,
                  bold: rowIndex === 0
                })
              ]
            })
          ]
        })
      )
    });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows
  });
}

export async function markdownToDocxBuffer(markdown) {
  const lines = markdown.split(/\r?\n/);
  const children = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (isMarkdownTableLine(line)) {
      const tableLines = [line];
      let j = i + 1;
      while (j < lines.length && isMarkdownTableLine(lines[j])) {
        tableLines.push(lines[j]);
        j += 1;
      }

      children.push(markdownTableToDocxTable(tableLines));
      children.push(new Paragraph({ text: "" }));
      i = j - 1;
      continue;
    }

    children.push(markdownLineToParagraph(line));
  }

  const doc = new Document({
    sections: [{ children }]
  });

  return Packer.toBuffer(doc);
}
