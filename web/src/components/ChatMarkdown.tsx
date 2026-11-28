import { Fragment } from "react";

function inline(text: string) {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={index} className="rounded bg-slate-100 px-1">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

export function ChatMarkdown({ text }: { text: string }) {
  // React renders all model content as text, including HTML and link destinations.
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length;) {
    const start = index;
    const line = lines[index++]!;
    if (!line.trim()) continue;
    if (/^\s{0,3}```/.test(line)) {
      const code = [];
      while (index < lines.length && !/^\s{0,3}```\s*$/.test(lines[index]!)) code.push(lines[index++]!);
      if (index < lines.length) index++;
      blocks.push(<pre key={start} className="whitespace-pre-wrap break-words rounded-lg bg-slate-100 p-2.5"><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push(<h2 key={start} className="font-semibold">{inline(heading[1]!)}</h2>);
      continue;
    }
    const item = /^\s{0,3}([-*+]|\d+[.)])\s+(.+)$/;
    const first = item.exec(line);
    if (first) {
      const ordered = /^\d/.test(first[1]!);
      const List = ordered ? "ol" : "ul";
      const items = [first[2]!];
      while (index < lines.length) {
        const next = item.exec(lines[index]!);
        if (!next || /^\d/.test(next[1]!) !== ordered) break;
        items.push(next[2]!);
        index++;
      }
      blocks.push(<List key={start} className={ordered ? "list-decimal pl-5" : "list-disc pl-5"}>
        {items.map((value, itemIndex) => <li key={itemIndex}>{inline(value)}</li>)}
      </List>);
      continue;
    }
    const paragraph = [line];
    while (index < lines.length && lines[index]!.trim() &&
      !/^\s{0,3}(```|#{1,6}\s+)/.test(lines[index]!) && !item.test(lines[index]!)) paragraph.push(lines[index++]!);
    blocks.push(<p key={start} className="whitespace-pre-wrap">{inline(paragraph.join("\n"))}</p>);
  }
  return <div className="min-w-0 space-y-2 break-words text-xs leading-relaxed md:text-sm">{blocks}</div>;
}
