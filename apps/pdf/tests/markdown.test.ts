import { describe, expect, it } from 'vitest'
import { parseBlocks, type MdBlock } from '@arareader/ui'

/** All text a block carries, so a streaming prefix can be checked for loss. */
function textOf(blocks: MdBlock[]): string {
  return blocks
    .map((b) => {
      if (b.kind === 'table') return [...b.headers, ...b.rows.flat()].join(' ')
      if (b.kind === 'code') return b.code
      if (b.kind === 'truncated') return b.text
      return JSON.stringify(b)
    })
    .join(' ')
}

describe('parseBlocks markdown parser', () => {
  it('parses headings without infinite loop', () => {
    const blocks = parseBlocks('# Heading 1\n## Heading 2\n### Heading 3')
    expect(blocks).toEqual([
      { kind: 'h', level: 1, text: 'Heading 1' },
      { kind: 'h', level: 2, text: 'Heading 2' },
      { kind: 'h', level: 3, text: 'Heading 3' },
    ])
  })

  it('parses horizontal rules without infinite loop', () => {
    const blocks = parseBlocks('---\n***\n___')
    expect(blocks).toEqual([{ kind: 'hr' }, { kind: 'hr' }, { kind: 'hr' }])
  })

  it('parses hashtag without space as a paragraph without infinite loop', () => {
    const blocks = parseBlocks('#tag1 #tag2\n#123')
    expect(blocks).toEqual([{ kind: 'p', lines: ['#tag1 #tag2', '#123'] }])
  })

  it('parses table and adjacent paragraphs', () => {
    const input = `Before table
| Header 1 | Header 2 |
|---|---|
| Cell 1 | Cell 2 |
After table`
    const blocks = parseBlocks(input)
    expect(blocks).toEqual([
      { kind: 'p', lines: ['Before table'] },
      {
        kind: 'table',
        headers: ['Header 1', 'Header 2'],
        rows: [['Cell 1', 'Cell 2']],
      },
      { kind: 'p', lines: ['After table'] },
    ])
  })

  it('handles isolated pipe line without dropping next line', () => {
    const input = '| not a table |\nHello world'
    const blocks = parseBlocks(input)
    expect(blocks).toEqual([{ kind: 'p', lines: ['| not a table |', 'Hello world'] }])
  })

  it('handles empty and whitespace-only text', () => {
    expect(parseBlocks('')).toEqual([])
    expect(parseBlocks('\n\n\n')).toEqual([])
    expect(parseBlocks('   \n  \t  \n')).toEqual([])
  })

  it('parses mixed complex markdown document', () => {
    const input = `# Summary
This document contains #key points from page 1.

---

## Details
> Quoted note
> second line

- Bullet A
- Bullet B

1. First
2. Second`
    const blocks = parseBlocks(input)
    expect(blocks.length).toBe(7)
    expect(blocks[0]).toEqual({ kind: 'h', level: 1, text: 'Summary' })
    expect(blocks[1]).toEqual({
      kind: 'p',
      lines: ['This document contains #key points from page 1.'],
    })
    expect(blocks[2]).toEqual({ kind: 'hr' })
    expect(blocks[3]).toEqual({ kind: 'h', level: 2, text: 'Details' })
    expect(blocks[4]).toEqual({ kind: 'quote', lines: ['Quoted note', 'second line'] })
    expect(blocks[5]).toEqual({ kind: 'ul', items: ['Bullet A', 'Bullet B'] })
    expect(blocks[6]).toEqual({ kind: 'ol', start: 1, items: ['First', 'Second'] })
  })

  it('splits trailing question glued to last ordered item', () => {
    const blocks = parseBlocks(
      '7. Final proofread and prepare for sharing What type of document would you like to draft?',
    )
    expect(blocks).toEqual([
      { kind: 'ol', start: 7, items: ['Final proofread and prepare for sharing'] },
      { kind: 'p', lines: ['What type of document would you like to draft?'] },
    ])
  })

  it('splits trailing question glued to last bullet', () => {
    const blocks = parseBlocks('- Alpha release\n- Beta release When do you want to ship?')
    expect(blocks).toEqual([
      { kind: 'ul', items: ['Alpha release', 'Beta release'] },
      { kind: 'p', lines: ['When do you want to ship?'] },
    ])
  })

  it('splits trailing CTA glued to last bullet', () => {
    const blocks = parseBlocks(
      '- References — formatted in the target style (e.g., APA or IEEE) Click the action button below to open and build the full draft in ARAReader.',
    )
    expect(blocks).toEqual([
      {
        kind: 'ul',
        items: ['References — formatted in the target style (e.g., APA or IEEE)'],
      },
      {
        kind: 'p',
        lines: ['Click the action button below to open and build the full draft in ARAReader.'],
      },
    ])
  })

  it('splits glued bullet when intro exceeds 200 characters', () => {
    const longIntro =
      "Here's a ready-to-build outline for a Scopus-indexed journal article on AI and Human Literacy, structured in the standard IMRaD-style format used by most Scopus journals: Proposed article structure:"
    const input = `${longIntro} - Title & Abstract`
    const blocks = parseBlocks(input)
    expect(blocks).toEqual([
      { kind: 'p', lines: [longIntro] },
      { kind: 'ul', items: ['Title & Abstract'] },
    ])
  })

  it('keeps single-sentence items intact', () => {
    const blocks = parseBlocks('1. First item here\n2. Second item here')
    expect(blocks).toEqual([
      { kind: 'ol', start: 1, items: ['First item here', 'Second item here'] },
    ])
  })

  describe('GFM tables (R4)', () => {
    it('parses a borderless table', () => {
      const blocks = parseBlocks('Name | Value\n--- | ---\nAlpha | 1\nBeta | 2')
      expect(blocks).toEqual([
        {
          kind: 'table',
          headers: ['Name', 'Value'],
          rows: [
            ['Alpha', '1'],
            ['Beta', '2'],
          ],
        },
      ])
    })

    it('parses a table with no trailing pipe', () => {
      const blocks = parseBlocks('| Name | Value\n| --- | ---\n| Alpha | 1')
      expect(blocks).toEqual([
        { kind: 'table', headers: ['Name', 'Value'], rows: [['Alpha', '1']] },
      ])
    })

    it('parses a table with no leading pipe', () => {
      const blocks = parseBlocks('Name | Value |\n--- | --- |\nAlpha | 1 |')
      expect(blocks).toEqual([
        { kind: 'table', headers: ['Name', 'Value'], rows: [['Alpha', '1']] },
      ])
    })

    it('parses mixed bordered header and borderless body rows', () => {
      const input = '| Name | Value |\n| --- | --- |\nAlpha | 1\n| Beta | 2 |\nAfter table'
      expect(parseBlocks(input)).toEqual([
        {
          kind: 'table',
          headers: ['Name', 'Value'],
          rows: [
            ['Alpha', '1'],
            ['Beta', '2'],
          ],
        },
        { kind: 'p', lines: ['After table'] },
      ])
    })

    it('keeps escaped pipes inside a cell instead of splitting columns', () => {
      const input = '| Op | Note |\n| --- | --- |\n| a \\| b | both |'
      expect(parseBlocks(input)).toEqual([
        { kind: 'table', headers: ['Op', 'Note'], rows: [['a | b', 'both']] },
      ])
    })

    it('unescapes a pipe in the header row', () => {
      const blocks = parseBlocks('| a \\| b | c |\n| --- | --- |\n| 1 | 2 |')
      expect(blocks).toEqual([{ kind: 'table', headers: ['a | b', 'c'], rows: [['1', '2']] }])
    })

    it('keeps a bare or escaped pipe inside a code span in one cell', () => {
      const bare = parseBlocks('| Code | N |\n| --- | --- |\n| `a|b` | 2 |')
      expect(bare).toEqual([{ kind: 'table', headers: ['Code', 'N'], rows: [['`a|b`', '2']] }])
      const escaped = parseBlocks('| Code | N |\n| --- | --- |\n| `a\\|b` | 2 |')
      expect(escaped).toEqual([{ kind: 'table', headers: ['Code', 'N'], rows: [['`a|b`', '2']] }])
    })

    it('accepts aligned delimiter rows', () => {
      const blocks = parseBlocks('| L | C | R |\n| :--- | :---: | ---: |\n| a | b | c |')
      expect(blocks).toEqual([{ kind: 'table', headers: ['L', 'C', 'R'], rows: [['a', 'b', 'c']] }])
    })

    it('ends the table at a heading, list or quote without swallowing them', () => {
      const input = '| A | B |\n| --- | --- |\n| 1 | 2 |\n## Next\n- item\n> quoted'
      const blocks = parseBlocks(input)
      expect(blocks[0]).toEqual({ kind: 'table', headers: ['A', 'B'], rows: [['1', '2']] })
      expect(blocks[1]).toEqual({ kind: 'h', level: 2, text: 'Next' })
      expect(blocks[2]).toEqual({ kind: 'ul', items: ['item'] })
      expect(blocks[3]).toEqual({ kind: 'quote', lines: ['quoted'] })
    })

    it('does not treat prose plus a setext rule as a borderless table', () => {
      expect(parseBlocks('cost | revenue\n---')).toEqual([
        { kind: 'p', lines: ['cost | revenue'] },
        { kind: 'hr' },
      ])
      expect(parseBlocks('Title\n---')).toEqual([{ kind: 'p', lines: ['Title'] }, { kind: 'hr' }])
    })

    it('does not treat a list item as a table header', () => {
      const blocks = parseBlocks('- alpha | beta\n--- | ---')
      expect(blocks.some((b) => b.kind === 'table')).toBe(false)
      expect(blocks[0]).toEqual({ kind: 'ul', items: ['alpha | beta'] })
    })

    it('keeps the parser quiet and lossless for every streamed prefix', () => {
      const doc = '| Name | Value |\n| --- | --- |\n| Alpha | 1 |\n| Beta | 2 |\nAfter the table'
      const tokens = ['Name', 'Value', 'Alpha', 'Beta', 'After']
      for (let end = 1; end <= doc.length; end++) {
        const prefix = doc.slice(0, end)
        const text = textOf(parseBlocks(prefix))
        for (const token of tokens) {
          const start = doc.indexOf(token)
          if (start >= 0 && start + token.length <= end) expect(text).toContain(token)
        }
      }
      // the complete answer still renders as a real table
      expect(parseBlocks(doc)[0]).toEqual({
        kind: 'table',
        headers: ['Name', 'Value'],
        rows: [
          ['Alpha', '1'],
          ['Beta', '2'],
        ],
      })
    })
  })

  describe('block budget (R4)', () => {
    const paragraphs = (n: number) =>
      Array.from({ length: n }, (_, i) => `para ${i + 1}`).join('\n\n')

    it('keeps the tail past the block budget instead of dropping it', () => {
      const blocks = parseBlocks(paragraphs(2100))
      expect(blocks).toHaveLength(2001)
      expect(blocks[0]).toEqual({ kind: 'p', lines: ['para 1'] })
      const last = blocks[2000]
      expect(last?.kind).toBe('truncated')
      expect(last?.kind === 'truncated' ? last.text : '').toContain('para 2100')
    })

    it('adds no truncation block at or below the budget', () => {
      const blocks = parseBlocks(paragraphs(2000))
      expect(blocks).toHaveLength(2000)
      expect(blocks.some((b) => b.kind === 'truncated')).toBe(false)
    })
  })
})
