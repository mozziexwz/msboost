import type { ReactNode } from 'react';

function inline(value: string): ReactNode[] {
  const parts = value.split(/(!?\[[^\]]*\]\([^\s)]+\)|`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    const image = part.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (image)
      return <img key={i} src={image[2]} alt={image[1]} loading="lazy" />;
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
    if (link)
      return (
        <a key={i} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      );
    if (/^`[^`]+`$/.test(part)) return <code key={i}>{part.slice(1, -1)}</code>;
    if (/^\*\*[^*]+\*\*$/.test(part))
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

export default function Markdown({ body }: { body: string }) {
  return (
    <div className="markdown-body">
      {String(body || '')
        .split('\n')
        .map((line, i) => {
          if (!line.trim()) return <span className="markdown-space" key={i} />;
          const heading = line.match(/^(#{1,3})\s+(.+)$/);
          if (heading) {
            const Tag = `h${heading[1].length}` as 'h1' | 'h2' | 'h3';
            return <Tag key={i}>{inline(heading[2])}</Tag>;
          }
          if (/^>\s?/.test(line))
            return (
              <blockquote key={i}>
                {inline(line.replace(/^>\s?/, ''))}
              </blockquote>
            );
          if (/^[-*]\s+/.test(line))
            return (
              <p className="markdown-list" key={i}>
                • {inline(line.replace(/^[-*]\s+/, ''))}
              </p>
            );
          if (/^\d+\.\s+/.test(line))
            return (
              <p className="markdown-list" key={i}>
                {inline(line)}
              </p>
            );
          return <p key={i}>{inline(line)}</p>;
        })}
    </div>
  );
}
