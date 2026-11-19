/**
 * Names as the machine-readable zone writes them (ICAO Doc 9303, Part 3, section 6) and the matching of a directory
 * entry to a document read (decision 62; ayni-spec D88, IDENT-DIR-003).
 */
import { describe, expect, it } from 'vitest'
import {
  entryMatchesDocument,
  firstNameMatches,
  lastNameMatches,
  nameFieldFilled,
  nameWords,
  transliterate,
  wordForms,
} from '../src/core/icao.js'

describe('the transliteration of Part 3 (IDENT-DIR-003)', () => {
  it('writes a letter with a mark as its base letter, or as the table writes it', () => {
    expect(transliterate('Ríos')).toBe('RIOS')
    expect(transliterate('María José')).toBe('MARIA JOSE')
    expect(wordForms('Müller').sort()).toEqual(['MUELLER', 'MULLER', 'MUXXLLER'])
    expect(wordForms('Peña').sort()).toEqual(['PENA', 'PENXXA'])
    expect(wordForms('Åsa').sort()).toEqual(['AASA', 'ASA'])
    expect(wordForms('Björk').sort()).toEqual(['BJOERK', 'BJORK'])
    expect(wordForms('Søren').sort()).toEqual(['SOEREN', 'SOREN'])
    expect(wordForms('Gärtner').sort()).toEqual(['GAERTNER', 'GARTNER'])
    expect(transliterate('Łukasz Żółć')).toBe('LUKASZ ZOLC')
    expect(transliterate('Đorđe Čolić')).toBe('DORDE COLIC')
    expect(transliterate('Ştefan Ţurcanu')).toBe('STEFAN TURCANU')
    expect(transliterate('Çelik Ağaoğlu')).toBe('CELIK AGAOGLU')
  })

  it('writes the letters the table gives two letters for', () => {
    expect(transliterate('Strauß')).toBe('STRAUSS')
    expect(transliterate('Ægir')).toBe('AEGIR')
    expect(transliterate('Œuvray')).toBe('OEUVRAY')
    expect(transliterate('Þórunn')).toBe('THORUNN')
    expect(transliterate('Ĳsbrand')).toBe('IJSBRAND')
  })

  it('drops an apostrophe and makes a space, a hyphen or any other sign one separator', () => {
    expect(transliterate("O'Brien")).toBe('OBRIEN')
    expect(transliterate('D’Angelo')).toBe('DANGELO')
    expect(transliterate('Jean-Pierre')).toBe('JEAN PIERRE')
    expect(transliterate('  de la  Cruz  ')).toBe('DE LA CRUZ')
    expect(transliterate('Smith--Jones, Jr.')).toBe('SMITH JONES JR')
    expect(nameWords('Anne-Marie  Dupont')).toEqual(['Anne', 'Marie', 'Dupont'])
  })

  it('gives no Latin form to a letter of another script: such a name never matches', () => {
    expect(wordForms('Иван')).toEqual([])
    expect(lastNameMatches('Иванов', 'IVANOV')).toBe(false)
    expect(lastNameMatches('Ivan Иванов', 'IVAN')).toBe(false)
  })
})

describe('the names of an entry and of a document (IDENT-DIR-003)', () => {
  it('needs the same last name, word for word, in either form of the table', () => {
    expect(lastNameMatches('Ríos', 'RIOS')).toBe(true)
    expect(lastNameMatches('Müller', 'MUELLER')).toBe(true)
    expect(lastNameMatches('Müller', 'MULLER')).toBe(true)
    expect(lastNameMatches('Müller', 'MUXXLLER')).toBe(true)
    expect(lastNameMatches('Mueller', 'MULLER')).toBe(false)
    expect(lastNameMatches('Ríos García', 'RIOS GARCIA')).toBe(true)
    // a part of a compound surname is not the surname
    expect(lastNameMatches('Ríos', 'RIOS GARCIA')).toBe(false)
    expect(lastNameMatches('de Vries', 'DE VRIES')).toBe(true)
    expect(lastNameMatches('O’Neill', 'ONEILL')).toBe(true)
  })

  it('takes the words of the first name among the given names, in their order', () => {
    expect(firstNameMatches('Ana', 'ANA MARIA')).toBe(true)
    expect(firstNameMatches('María', 'ANA MARIA')).toBe(true)
    expect(firstNameMatches('Ana María', 'ANA MARIA')).toBe(true)
    expect(firstNameMatches('Ana Carmen', 'ANA MARIA CARMEN')).toBe(true)
    expect(firstNameMatches('María Ana', 'ANA MARIA')).toBe(false)
    expect(firstNameMatches('Anabel', 'ANA MARIA')).toBe(false)
    expect(firstNameMatches('Jürgen', 'JUERGEN')).toBe(true)
    expect(firstNameMatches('Jean-Pierre', 'JEAN PIERRE')).toBe(true)
    expect(firstNameMatches('Ana', '')).toBe(false)
  })

  it('lets a name the zone cut for want of room match what it holds (Part 3, 4.6.5)', () => {
    // TD3: a field of 39 characters, the surname, two fillers, the given names, one filler between words
    expect('GONZALEZ<DE<LA<TORRES<<MARIA<DEL<CARMEN').toHaveLength(39)
    expect(nameFieldFilled('GONZALEZ DE LA TORRES', 'MARIA DEL CARMEN')).toBe(true)
    expect(nameFieldFilled('GONZALEZ DE LA TORRE', 'MARIA DEL CARMEN')).toBe(false)
    // María del Carmencita was cut to CARMEN: her last given name begins with what the zone holds
    expect(firstNameMatches('María del Carmencita', 'MARIA DEL CARMEN', true)).toBe(true)
    expect(firstNameMatches('Carmencita', 'MARIA DEL CARMEN', true)).toBe(true)
    expect(firstNameMatches('María del Carmencita', 'MARIA DEL CARMEN', false)).toBe(false)
    // only the last word of the zone may have been cut
    expect(firstNameMatches('Marianne', 'MARIA DEL CARMEN', true)).toBe(false)
    // a surname alone, cut: the entry's begins with what the zone holds
    const surname = 'Wolfeschlegelsteinhausenbergerdorffwelchevoralternwaren'
    const zone = surname.toUpperCase().slice(0, 39)
    expect(nameFieldFilled(zone, '')).toBe(true)
    expect(lastNameMatches(surname, zone, true)).toBe(true)
    expect(lastNameMatches(surname, zone, false)).toBe(false)
    // the surname filled the field: no room was left for the given names, and the entry's first name matches
    const document = { lastName: zone, firstName: '', dateOfBirth: '1990-01-01', nationality: 'D' }
    const hubert = { firstName: 'Hubert', lastName: surname, birthDate: '1990-01-01', nationality: 'D' }
    expect(entryMatchesDocument(hubert, document)).toBeUndefined()
    // a short surname with no given names on the document: the entry's first name is not among them
    const short = { lastName: 'SUKARNO', firstName: '', dateOfBirth: '1990-01-01', nationality: 'D' }
    expect(entryMatchesDocument({ ...hubert, lastName: 'Sukarno' }, short)).toBe('first-name')
  })
})

describe('an entry is the person of a document (IDENT-DIR-003)', () => {
  const read = { lastName: 'RIOS', firstName: 'ANA MARIA', dateOfBirth: '1991-05-21', nationality: 'ESP' }
  const ana = { firstName: 'Ana', lastName: 'Ríos', birthDate: '1991-05-21', nationality: 'ESP' }

  it('matches on the date of birth, the nationality, the last name and the first names', () => {
    expect(entryMatchesDocument(ana, read)).toBeUndefined()
    expect(entryMatchesDocument({ ...ana, firstName: 'María' }, read)).toBeUndefined()
    expect(entryMatchesDocument({ ...ana, nationality: 'esp' }, read)).toBeUndefined()
  })

  it('names the first test that fails, never a value', () => {
    expect(entryMatchesDocument({ ...ana, birthDate: '1991-05-22' }, read)).toBe('birth-date')
    expect(entryMatchesDocument({ ...ana, birthDate: undefined }, read)).toBe('birth-date')
    expect(entryMatchesDocument({ ...ana, nationality: 'COL' }, read)).toBe('nationality')
    expect(entryMatchesDocument({ ...ana, lastName: 'Ruiz' }, read)).toBe('last-name')
    expect(entryMatchesDocument({ ...ana, firstName: 'Lucía' }, read)).toBe('first-name')
  })

  it('reads a one-letter code of the zone as the zone writes it (D for Germany)', () => {
    const erika = { lastName: 'MUSTERMANN', firstName: 'ERIKA', dateOfBirth: '1964-08-12', nationality: 'D' }
    expect(
      entryMatchesDocument(
        { firstName: 'Erika', lastName: 'Mustermann', birthDate: '1964-08-12', nationality: 'D' },
        erika
      )
    ).toBeUndefined()
    expect(
      entryMatchesDocument(
        { firstName: 'Erika', lastName: 'Mustermann', birthDate: '1964-08-12', nationality: 'DEU' },
        erika
      )
    ).toBe('nationality')
  })
})
