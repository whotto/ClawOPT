import React from 'react';

const SEARCH_HIGHLIGHT_CLASS_NAME = 'rounded-[4px] bg-[#fff3b0] px-0.5 text-inherit';
function highlightSearchText(text: string, query: string, keyPrefix: string): React.ReactNode {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return text;

  const lowerText = text.toLowerCase();
  const lowerQuery = normalizedQuery.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let matchIndex = 0;

  while (cursor < text.length) {
    const matchStart = lowerText.indexOf(lowerQuery, cursor);
    if (matchStart === -1) {
      if (parts.length === 0) return text;
      parts.push(<React.Fragment key={`${keyPrefix}-tail`}>{text.slice(cursor)}</React.Fragment>);
      return parts;
    }

    if (matchStart > cursor) {
      parts.push(
        <React.Fragment key={`${keyPrefix}-text-${matchIndex}`}>
          {text.slice(cursor, matchStart)}
        </React.Fragment>
      );
    }

    const matchEnd = matchStart + normalizedQuery.length;
    parts.push(
      <mark key={`${keyPrefix}-match-${matchIndex}`} className={SEARCH_HIGHLIGHT_CLASS_NAME}>
        {text.slice(matchStart, matchEnd)}
      </mark>
    );

    cursor = matchEnd;
    matchIndex += 1;
  }

  return parts.length > 0 ? parts : text;
}

export function highlightSearchNodes(node: React.ReactNode, query: string, keyPrefix = 'search'): React.ReactNode {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return node;

  if (typeof node === 'string') {
    return highlightSearchText(node, normalizedQuery, keyPrefix);
  }

  if (typeof node === 'number') {
    return highlightSearchText(String(node), normalizedQuery, keyPrefix);
  }

  if (node == null || typeof node === 'boolean') {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map((child, index) => (
      <React.Fragment key={`${keyPrefix}-${index}`}>
        {highlightSearchNodes(child, normalizedQuery, `${keyPrefix}-${index}`)}
      </React.Fragment>
    ));
  }

  if (!React.isValidElement(node) || node.type === 'mark') {
    return node;
  }

  if (typeof node.type === 'string' && (node.type === 'code' || node.type === 'pre' || node.type === 'svg')) {
    return node;
  }

  const children = (node.props as { children?: React.ReactNode }).children;
  if (children === undefined) {
    return node;
  }

  return React.cloneElement(
    node,
    undefined,
    highlightSearchNodes(
      children,
      normalizedQuery,
      `${keyPrefix}-${typeof node.type === 'string' ? node.type : 'node'}`
    )
  );
}
