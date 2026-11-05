import { describe, expect, it } from 'vitest'
import {
  ARA_ASSISTANT_IDENTITY,
  ARA_ASSISTANT_NAME,
  ARA_ASSISTANT_SHARED_POLICY,
  ARA_IDENTITY_CORE,
  ARA_IDENTITY_RULES,
  ARA_POLICY_CORE,
  ARA_POLICY_CRAFT,
  ARA_POLICY_WORK,
  ARA_PRODUCT_NAME,
  ARA_SUITE_CATALOG,
  DEFAULT_IDENTITY_FALLBACK,
  needsIdentityDetail,
  needsSuiteCatalog,
  sanitizeModelIdentity,
} from '../src'

describe('identity guardrails and sanitizeModelIdentity', () => {
  it('defines the ARA Assistant identity with ARAReader and no creator claims or brand details', () => {
    expect(ARA_ASSISTANT_NAME).toBe('ARA Assistant')
    expect(ARA_PRODUCT_NAME).toBe('ARAReader')
    expect(ARA_ASSISTANT_IDENTITY).toContain('ARA Assistant')
    expect(ARA_ASSISTANT_IDENTITY).toContain('ARAReader')
    // Prompt text stays on the ARAReader identity; it must not name a creator
    // or an external model vendor.
    expect(ARA_ASSISTANT_IDENTITY).toContain('PDF Documents')
    expect(ARA_ASSISTANT_IDENTITY).toContain('Annotations & Markup')
    expect(ARA_ASSISTANT_IDENTITY).toContain('Forms & Page Edits')
    expect(ARA_ASSISTANT_IDENTITY).toContain('Attachments & Web')
    expect(ARA_ASSISTANT_IDENTITY).toContain('Local & Private')
    expect(ARA_ASSISTANT_IDENTITY).toContain('.pdf')
    expect(ARA_IDENTITY_RULES).not.toContain('OpenAI')
    expect(ARA_SUITE_CATALOG).not.toContain('xlsx-engine')
    expect(ARA_SUITE_CATALOG).not.toContain('byte-anchored')
    expect(ARA_POLICY_WORK).not.toContain('insert_content')
    expect(ARA_POLICY_WORK).not.toContain('UNESCO')
    expect(ARA_POLICY_CRAFT).not.toMatch(/#[0-9a-f]{6}/i)
    expect(ARA_ASSISTANT_SHARED_POLICY).toContain('Brand & Identity Consistency')
  })

  it('scopes the catalog to the PDF-only product, with no office-suite domains', () => {
    for (const stale of [
      'Docs',
      'Sheets',
      'Slides',
      'Markdown Documents',
      'Visual Diagrams & Flowcharts',
      '.docx',
      '.xlsx',
      '.pptx',
      '.mermaid',
      '.doc',
      '.xls',
      '.ppt',
      '.md',
      '.markdown',
      '.drawio',
      'ARAOffice',
      'office copilot',
    ]) {
      expect(ARA_ASSISTANT_IDENTITY).not.toContain(stale)
    }
    expect(ARA_ASSISTANT_IDENTITY).not.toMatch(/all 6|list all 6|6 formats/i)
    expect(ARA_SUITE_CATALOG).toContain('PDF reader and editor')
    expect(ARA_SUITE_CATALOG).toMatch(/never claim Word/i)
    expect(DEFAULT_IDENTITY_FALLBACK).toBe('I am ARA Assistant, the PDF assistant for ARAReader.')
  })

  it('carries no competitor-defense copy', () => {
    expect(ARA_ASSISTANT_IDENTITY).not.toContain('competitor')
    expect(ARA_ASSISTANT_IDENTITY).not.toContain('third-party AI companies')
    expect(ARA_ASSISTANT_IDENTITY).not.toContain('Never be defensive')
    expect(ARA_ASSISTANT_IDENTITY).not.toContain('NEVER volunteer unprompted denials')
    expect(ARA_ASSISTANT_SHARED_POLICY).not.toContain('third-party AI providers')
  })

  it('normalizes whitespace and spaces before punctuation', () => {
    const input = 'Hello   world  !   How are you   ?  '
    expect(sanitizeModelIdentity(input)).toBe('Hello world! How are you?')
  })

  it('restores missing space after sentence punctuation', () => {
    const input = 'Hi there!I am ARA Assistant.How can I help you today?'
    expect(sanitizeModelIdentity(input)).toBe(
      'Hi there! I am ARA Assistant. How can I help you today?',
    )
  })

  it('strips preamble patterns if pattern option is provided', () => {
    const input = '<preamble>System ready.</preamble>Here is the draft document.'
    const cleaned = sanitizeModelIdentity(input, { pattern: /<preamble>.*?<\/preamble>/gi })
    expect(cleaned).toBe('Here is the draft document.')
  })

  it('discards empty strings and falls back to default identity', () => {
    expect(sanitizeModelIdentity('')).toBe(DEFAULT_IDENTITY_FALLBACK)
    expect(sanitizeModelIdentity('   ')).toBe(DEFAULT_IDENTITY_FALLBACK)
  })

  it('discards bare negation and returns fallback identity', () => {
    expect(sanitizeModelIdentity('No.')).toBe(DEFAULT_IDENTITY_FALLBACK)
    expect(sanitizeModelIdentity('No, no.')).toBe(DEFAULT_IDENTITY_FALLBACK)
    expect(sanitizeModelIdentity('Tidak.')).toBe(DEFAULT_IDENTITY_FALLBACK)
  })

  it('honors custom fallbackText and allowFallback options', () => {
    expect(sanitizeModelIdentity('', { allowFallback: false })).toBe('')
    expect(
      sanitizeModelIdentity('', {
        fallbackText: 'Custom assistant fallback.',
      }),
    ).toBe('Custom assistant fallback.')
    expect(sanitizeModelIdentity('No.', { allowFallback: false })).toBe('')
  })

  it('preserves clean text unchanged', () => {
    const input = 'Here is the summary of your quarterly earnings report.'
    expect(sanitizeModelIdentity(input)).toBe(input)
  })

  it('preserves business or document discussions about AI companies', () => {
    const docText =
      'The presentation compares OpenAI, Anthropic, and Cohere enterprise search models for Q3.'
    expect(sanitizeModelIdentity(docText)).toBe(docText)
  })

  it('chunks reassemble to the compat full strings', () => {
    expect(`${ARA_IDENTITY_CORE}\n\n${ARA_IDENTITY_RULES}\n\n${ARA_SUITE_CATALOG}`).toBe(
      ARA_ASSISTANT_IDENTITY,
    )
    expect(`${ARA_POLICY_CORE}\n${ARA_POLICY_WORK}\n${ARA_POLICY_CRAFT}`).toBe(
      ARA_ASSISTANT_SHARED_POLICY,
    )
    expect(ARA_IDENTITY_CORE.length).toBeLessThan(ARA_ASSISTANT_IDENTITY.length / 5)
    expect(ARA_POLICY_CORE.length).toBeLessThan(ARA_ASSISTANT_SHARED_POLICY.length / 3)
  })

  it('gates fire on identity/capability asks, stay quiet on work tasks', () => {
    expect(needsIdentityDetail('siapa kamu?')).toBe(true)
    expect(needsIdentityDetail('are you a human?')).toBe(true)
    expect(needsIdentityDetail('apakah kamu model buatan siapa?')).toBe(true)
    expect(needsSuiteCatalog('hi who are you?')).toBe(false)
    expect(needsSuiteCatalog('siapa kamu?')).toBe(false)
    expect(needsSuiteCatalog('what can you do?')).toBe(true)
    expect(needsSuiteCatalog('what file formats do you support?')).toBe(true)
    expect(needsSuiteCatalog('which formats are supported?')).toBe(true)
    expect(needsSuiteCatalog('apa saja format yang didukung?')).toBe(true)
    expect(needsSuiteCatalog('fitur apa saja yang didukung?')).toBe(true)
    expect(needsIdentityDetail('tolong ringkas dokumen ini')).toBe(false)
    expect(needsSuiteCatalog('tolong format paragraf ini')).toBe(false)
    expect(needsSuiteCatalog('buatkan flowchart alur kasir')).toBe(false)
  })
})
