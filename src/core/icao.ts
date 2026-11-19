/**
 * Names as the machine-readable zone writes them (ICAO Doc 9303, Part 3, section 6, "Transliteration of multinational
 * Latin-based characters"), and the matching of a directory entry to a document read (ayni-spec D88, IDENT-DIR-003).
 *
 * The zone holds the capitals A to Z and a filler. A state writes a letter with a mark as the table of Part 3 writes it,
 * or as its base letter: `Ü` is `UE`, `UXX` or `U`, `Ñ` is `N` or `NXX`, `Ä` is `AE` or `A`. An entry of the directory
 * is written by hand in the person's own letters, so both forms are taken: a name matches when one of the ways the
 * table lets a state write it is what the zone holds. An apostrophe is dropped (`O'Brien` is `OBRIEN`); a space, a
 * hyphen or any other sign separates names, and several of them are one separator.
 *
 * A letter that is neither in the table nor a Latin letter with marks (a Cyrillic or a Greek letter, for one) has no
 * Latin form here: such a name never matches, rather than matching on the letters left around it.
 */

/** The table of Part 3, section 6, by capital letter: every form it gives, the base letter among them. */
const TABLE: Record<string, readonly string[]> = {
  Á: ['A'],
  À: ['A'],
  Â: ['A'],
  Ä: ['AE', 'A'],
  Ã: ['A'],
  Ă: ['A'],
  Å: ['AA', 'A'],
  Ā: ['A'],
  Ą: ['A'],
  Ć: ['C'],
  Ĉ: ['C'],
  Č: ['C'],
  Ċ: ['C'],
  Ç: ['C'],
  Đ: ['D'],
  Ð: ['D'],
  Ď: ['D'],
  É: ['E'],
  È: ['E'],
  Ê: ['E'],
  Ë: ['E'],
  Ě: ['E'],
  Ė: ['E'],
  Ē: ['E'],
  Ę: ['E'],
  Ĕ: ['E'],
  Ĝ: ['G'],
  Ğ: ['G'],
  Ġ: ['G'],
  Ģ: ['G'],
  Ħ: ['H'],
  Ĥ: ['H'],
  Í: ['I'],
  Ì: ['I'],
  Î: ['I'],
  Ï: ['I'],
  Ĩ: ['I'],
  İ: ['I'],
  Ī: ['I'],
  Į: ['I'],
  Ĭ: ['I'],
  Ĵ: ['J'],
  Ķ: ['K'],
  Ĺ: ['L'],
  Ľ: ['L'],
  Ļ: ['L'],
  Ł: ['L'],
  Ŀ: ['L'],
  Ń: ['N'],
  Ñ: ['N', 'NXX'],
  Ň: ['N'],
  Ņ: ['N'],
  Ŋ: ['N'],
  Ó: ['O'],
  Ò: ['O'],
  Ô: ['O'],
  Ö: ['OE', 'O'],
  Õ: ['O'],
  Ő: ['O'],
  Ø: ['OE', 'O'],
  Ō: ['O'],
  Ŏ: ['O'],
  Ŕ: ['R'],
  Ř: ['R'],
  Ŗ: ['R'],
  Ś: ['S'],
  Ŝ: ['S'],
  Š: ['S'],
  Ş: ['S'],
  Ș: ['S'],
  Ţ: ['T'],
  Ț: ['T'],
  Ť: ['T'],
  Ŧ: ['T'],
  Ú: ['U'],
  Ù: ['U'],
  Û: ['U'],
  Ü: ['UE', 'UXX', 'U'],
  Ũ: ['U'],
  Ŭ: ['U'],
  Ű: ['U'],
  Ů: ['U'],
  Ū: ['U'],
  Ų: ['U'],
  Ŵ: ['W'],
  Ý: ['Y'],
  Ŷ: ['Y'],
  Ÿ: ['Y'],
  Ź: ['Z'],
  Ž: ['Z'],
  Ż: ['Z'],
  Þ: ['TH'],
  Æ: ['AE'],
  Ĳ: ['IJ'],
  Œ: ['OE'],
  ẞ: ['SS'],
}

/** Signs dropped without separating: the apostrophes a name may be written with. */
const APOSTROPHES = /['’ʼ‘`´]/gu
/** One form per letter beyond this many ways of writing a word: the base letters only, then the table's first forms. */
const MAX_FORMS = 256

/** The ways the zone may write one letter of a name, in capitals; none for a letter with no Latin form. */
function lettersOf(char: string): readonly string[] {
  if (/^[A-Z]$/.test(char)) return [char]
  // `ß` has no capital of its own in the table: it is `SS`
  if (char === 'ß') return ['SS']
  const upper = char.toUpperCase()
  if (/^[A-Z]$/.test(upper)) return [upper]
  const listed = TABLE[upper] ?? TABLE[char]
  if (listed) return listed
  // a Latin letter with marks the table does not list: its base letter
  const base = upper.normalize('NFD').replace(/\p{M}/gu, '')
  return /^[A-Z]+$/.test(base) ? [base] : []
}

/** The words of a name as the zone separates them: an apostrophe dropped, any other sign a separator. */
export function nameWords(name: string): string[] {
  return name
    .normalize('NFC')
    .replace(APOSTROPHES, '')
    .split(/[^\p{L}\p{M}]+/u)
    .filter(Boolean)
}

/**
 * Every way the zone may write a word (IDENT-DIR-003): `Müller` gives `MUELLER`, `MUXXLLER` and `MULLER`. Empty when a
 * letter has no Latin form. Past `MAX_FORMS` ways, the base letters and the table's first forms only.
 */
export function wordForms(word: string): string[] {
  let forms: string[] = ['']
  const letters = [...word.normalize('NFC')].map(lettersOf)
  if (letters.some((l) => !l.length)) return []
  const ways = letters.reduce((n, l) => n * l.length, 1)
  for (const options of letters) {
    const chosen = ways > MAX_FORMS ? [...new Set([options[0], options[options.length - 1]])] : options
    forms = forms.flatMap((f) => chosen.map((o) => f + o))
  }
  return [...new Set(forms)]
}

/** A name as the zone writes it with base letters only: `Ríos García` is `RIOS GARCIA`. For logs and tests. */
export function transliterate(name: string): string {
  return nameWords(name)
    .map((w) => {
      const forms = wordForms(w)
      return forms[forms.length - 1] ?? ''
    })
    .join(' ')
}

/** The words of a name field of the zone, as the document read keeps it: capitals separated by spaces. */
function zoneWords(field: string): string[] {
  return field
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean)
}

/** The widths of the name field of the three formats of Part 4 to 6: TD1, TD2 (and MRV-B), TD3 (and MRV-A). */
const NAME_FIELD_WIDTHS = new Set([30, 31, 39])

/**
 * Whether the zone filled its name field to the end, so that a name may have been cut for want of room (Part 3,
 * 4.6.5): the field holds the surname, two fillers and the given names, words separated by one filler.
 */
export function nameFieldFilled(lastName: string, firstName: string): boolean {
  const last = zoneWords(lastName).join('<')
  const first = zoneWords(firstName).join('<')
  const length = first ? last.length + 2 + first.length : last.length
  return NAME_FIELD_WIDTHS.has(length)
}

/** Whether one way of writing the entry's word is the zone's word, or begins with it when the zone may have cut it. */
function wordMatches(forms: string[], zoneWord: string, cut: boolean): boolean {
  return forms.some((f) => f === zoneWord || (cut && f.startsWith(zoneWord)))
}

/**
 * The entry's last name equals the document's (IDENT-DIR-003), word for word. When the zone filled its name field and
 * holds no given name, the surname itself may have been cut: an entry whose surname begins with what the zone holds
 * matches.
 */
export function lastNameMatches(entryLastName: string, documentLastName: string, filled = false): boolean {
  const entry = nameWords(entryLastName).map(wordForms)
  const zone = zoneWords(documentLastName)
  if (!entry.length || !zone.length || entry.some((forms) => !forms.length)) return false
  if (entry.length === zone.length && zone.every((w, i) => wordMatches(entry[i] as string[], w, false))) return true
  if (!filled || zone.length > entry.length) return false
  // cut: every word of the zone but the last is whole, the last begins the entry's word
  return zone.every((w, i) => wordMatches(entry[i] as string[], w, i === zone.length - 1))
}

/**
 * The words of the entry's first name are words of the document's given names, in the same order (IDENT-DIR-003): `Ana`
 * and `María` both match `ANA MARIA`. When the zone filled its name field, its last given name may have been cut: an
 * entry's word that begins with it matches it.
 */
export function firstNameMatches(entryFirstName: string, documentFirstName: string, filled = false): boolean {
  const entry = nameWords(entryFirstName).map(wordForms)
  const zone = zoneWords(documentFirstName)
  if (!entry.length || !zone.length || entry.some((forms) => !forms.length)) return false
  let at = 0
  for (const forms of entry) {
    while (at < zone.length && !wordMatches(forms, zone[at] as string, filled && at === zone.length - 1)) at++
    if (at === zone.length) return false
    at++
  }
  return true
}

/** What a document read gives the matching (PRIV-EVID-012): the names as the zone writes them, the date, the code. */
export interface DocumentIdentity {
  lastName: string
  firstName: string
  /** `YYYY-MM-DD` */
  dateOfBirth: string
  /** the code of ICAO Doc 9303, `D` for Germany */
  nationality: string
}

/** What an entry of the directory gives the matching; its birthdate and nationality are read for it only (IDENT-DIR-007). */
export interface EntryIdentity {
  firstName: string
  lastName: string
  /** `YYYY-MM-DD` */
  birthDate?: string
  nationality?: string
}

/** Why an entry is not the one of a document: the first test it fails. A word, never a value (IDENT-DIR-007). */
export type MismatchReason = 'birth-date' | 'nationality' | 'last-name' | 'first-name'

/**
 * Whether an entry is the person of a document read (IDENT-DIR-003): the same date of birth and nationality, the same
 * last name and the entry's first names among the document's given names, after the transliteration of Part 3.
 */
export function entryMatchesDocument(entry: EntryIdentity, document: DocumentIdentity): MismatchReason | undefined {
  if (!entry.birthDate || entry.birthDate !== document.dateOfBirth) return 'birth-date'
  const nationality = (code: string | undefined) => (code ?? '').replace(/</g, '').trim().toUpperCase()
  if (!nationality(entry.nationality) || nationality(entry.nationality) !== nationality(document.nationality))
    return 'nationality'
  const filled = nameFieldFilled(document.lastName, document.firstName)
  const givenNames = zoneWords(document.firstName).length > 0
  if (!lastNameMatches(entry.lastName, document.lastName, filled && !givenNames)) return 'last-name'
  // a surname that filled the field left no room for the given names: what the zone holds of them is nothing, and every
  // first name begins with it
  if (filled && !givenNames) return undefined
  if (!firstNameMatches(entry.firstName, document.firstName, filled)) return 'first-name'
  return undefined
}
