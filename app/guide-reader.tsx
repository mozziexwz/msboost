'use client';
import { useState } from 'react';
import Markdown from './markdown';
type Article = { id: string; kind: string; title: string; body: string };
export default function GuideReader({ articles }: { articles: Article[] }) {
  const [selected, setSelected] = useState('');
  const entries = articles.filter((a) => a.kind !== 'notice');
  const current =
    entries.find((a) => a.id === selected) ||
    entries.find((a) => a.kind === 'guide') ||
    entries[0];
  return (
    <div className="guide-reader">
      <nav className="panel guide-directory" aria-label="教程目录">
        <h2>教程目录</h2>
        {entries.map((a) => (
          <button
            key={a.id}
            aria-current={current?.id === a.id ? 'page' : undefined}
            onClick={() => setSelected(a.id)}
          >
            {a.title}
          </button>
        ))}
      </nav>
      <article className="panel guide-content">
        {current ? (
          <>
            <h2>{current.title}</h2>
            <Markdown body={current.body} />
          </>
        ) : (
          <p>暂无教程</p>
        )}
      </article>
    </div>
  );
}
