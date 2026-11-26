# Ayni Feature Profiles, common part 1.0

> **Status:** DRAFT, **normative** for every MCP server that declares an Ayni feature profile (a **provider**) and
> for every client that relies on one, the Ayni Agent first.
> **Companions:** [files.md](files.md) (Files 1.0), [calendar.md](calendar.md) (Calendar 1.0),
> [providers.md](providers.md) (the first providers), [README.md](README.md) (scope, conventions, what exists publicly),
> the Ayni Agent's [architecture](../ayni-agent/architecture.md), D120 to D124 (design authority).

---

## Table of Contents

1. [Roles and scope](#1-roles-and-scope)
2. [What a profile is](#2-what-a-profile-is)
3. [Declaring a profile](#3-declaring-a-profile)
4. [Tools](#4-tools)
5. [References and versions](#5-references-and-versions)
6. [Locations](#6-locations)
7. [Pages](#7-pages)
8. [Time](#8-time)
9. [Errors](#9-errors)
10. [Effects, people named in a call, content written by others](#10-effects-people-named-in-a-call-content-written-by-others)
11. [Accounts](#11-accounts)
12. [Limits](#12-limits)
13. [Conformance](#13-conformance)
14. [Versions of a profile](#14-versions-of-a-profile)
15. [Requirements](#15-requirements)

---

## 1. Roles and scope

A **feature** is what a set of tools is for, in the words people use: Files, Calendar. A **feature profile** is the
public contract of one feature: the tools a server exposes for it, with their exact names, inputs, results, effects
and errors. A **provider** is an MCP server that implements a profile for one service: a file store, a calendar
server. A **client** is what calls the provider's tools for a model: an Ayni Agent, or any other MCP client. The
**service** is what the provider fronts, and the **account** is whose rights at the service a call runs with. These
are the words of this set, for any client; the Ayni Agent's glossary (its architecture §2) gives them for the agent,
where a provider is any tool source that serves a feature, with a contract or without.

The wire is MCP: `tools/list` and `tools/call`, with structured results. A profile adds no method to MCP and needs
nothing of a client that an MCP client does not already do. It fixes what MCP leaves to each server: the names and
shapes of the tools. Two providers of one profile can then be exchanged without the model, the rules written about
its tools or the words people read changing.

A profile says nothing of who may use a tool, of what a call needs before it runs (a confirmation, an approval) or of
what a client shows: those are the client's. For the Ayni Agent they are in its specification (TOOL-FEAT).

## 2. What a profile is

A profile has an **identifier**, written as an MCP extension identifier (`org.ayni/files`), and a **version**,
`major.minor` (`1.0`). It defines three kinds of tools:

| Kind | What it is | Who has it |
|---|---|---|
| **Core operations** | the tools every provider of the profile exposes, whole | every provider |
| **Optional capabilities** | named groups (`folders`, `share`) of further tools, and of further arguments and result fields of core tools | a provider that declares the capability, and then the whole of it |
| **Extras** | a provider's own tools, outside the profile | a provider that chooses to; a client offers them or not |

The tools of a profile share a prefix (`files_`, `calendar_`). No tool outside the profile uses it.

## 3. Declaring a profile

A provider declares each profile it implements as an MCP extension, in the `extensions` of its capabilities: in the
result of `server/discover` (MCP revision 2026-07-28 and later), or in the result of `initialize` for a server of an
earlier revision.

```json
{ "resultType": "complete",
  "supportedVersions": ["2026-07-28"],
  "capabilities": {
    "tools": {},
    "extensions": {
      "org.ayni/files": {
        "version": "1.0",
        "capabilities": ["folders", "search"],
        "limits": { "readBytes": 10485760, "writeBytes": 10485760, "page": 100 },
        "atomicWrites": true
      } } } }
```

| Member | Type | Meaning |
|---|---|---|
| `version` | string, required | the version of the profile the server implements, `major.minor` |
| `capabilities` | list of strings, required, may be empty | the optional capabilities the server has, by their names in the profile |
| `limits` | object | the server's limits (§12); an absent one is the profile's default |
| `atomicWrites` | boolean | whether a write that names a version is compared and written as one step (§5); `false` when absent |
| others | | each profile may add members of its own; a client ignores a member it does not know |

What a server declares MAY differ with the account of the request (an account of a plan with no sharing declares no
`share`), and MUST NOT differ otherwise. A client declares nothing: a provider's tools are plain MCP tools, and a
client that knows nothing of profiles uses them as any other.

## 4. Tools

Each profile gives, for each of its tools: its name, its title, a description, its arguments, each with a title, its
result, its effect, its errors and what of its result people other than the account's holder may have written (§10).
The **description** is what a client gives a model, word for word: a sentence or two on what the tool does, written
for every provider alike. The **titles** of the tool and of its arguments are what a client shows people, on a card
that asks for a confirmation and in a record of the call. The profile's documents are the authority; a
machine-readable copy of them (for each tool, `name`, `title`, `description`, `inputSchema` with the `title` of each
argument, `outputSchema`, its effect, its capability and its mark of content written by others) is published with
each version, generated from the documents.

- **Names.** Exactly the profile's: lower-case letters, digits and `_`, beginning with the profile's prefix.
- **Arguments.** The server's `inputSchema` of a profile's tool accepts every input the profile's arguments allow
  and requires nothing more. An argument the server does not know is refused (`invalid-argument`), never ignored. An
  argument or a value that belongs to a capability the server did not declare is refused (`not-supported`).
- **Results.** Every result carries `structuredContent`, an object with the members the profile gives for the tool,
  and one `text` content block holding the same object as JSON. A server MAY add members whose names begin with `x_`;
  a client ignores them.
- **Annotations.** MCP's hints follow the tool's effect (§10, FEAT-CORE-018). A client that knows the profile takes
  the effect from the profile, never from the hints.
- **Asking the person.** A profile's tool completes from its arguments alone. A question the service itself asks the
  person before it acts (a confirmation of its own) is passed on as an input request of the call, which a client may
  decline (FEAT-CORE-024).

## 5. References and versions

An item (a file, a folder, an event, a calendar) is named by its **reference**, `ref`: a string of 1 to 1024
characters that the provider makes and that a client keeps and gives back as it is, never reads and never builds. A
reference holds no credential and no signed address. It names its item for as long as the item is not moved, renamed
or deleted; an operation that moves or renames an item answers its reference afterwards. A provider whose service
gives items an identifier of their own uses it, so that a rename keeps the reference.

A **version** is a string of 1 to 255 characters that changes each time the item changes, and is compared for
equality only: an entity tag, a revision's identifier. Where an operation that changes an existing item takes
`ifVersion`, the provider compares it with the item's version and refuses the change when they differ
(`version-mismatch`, with the version in force). Where the service compares and writes in one step, so does the
provider, and it declares `atomicWrites: true`; otherwise it compares, then writes, and says `false`: a change made
between the two is then lost, and a client that needs more reads the item again after it writes.

## 6. Locations

A **location** is the part of an account that the operations of a profile are confined to: a folder for Files, a
calendar for Calendar. Each profile names its location argument (`root`, `calendar`) and the one core tool that lists
the locations the account reaches (`files_roots`, `calendar_calendars`). Every other tool of the profile takes the
location argument, required, and acts inside that location only:

- an item is inside a location when it is the location or is held by it, at any depth;
- a reference to an item that the location does not hold is answered `not-found`, as a reference to no item is,
  with nothing of the item in the answer, whatever the account may reach: the answer never tells that the item
  exists elsewhere;
- a result holds no item outside the location, and each item of a result carries the location it was read from;
- a destination given by reference (a folder's id) that the location does not hold answers `not-found`, as a read
  does; a destination given by path that would leave the location (`../HR`, a path that escapes it) is refused with
  `outside-location`, the one use of that code;
- a link kept inside a location to an item outside it (a shortcut, a symbolic link, a mount) is listed as a link and
  never followed: reading it answers `not-found` or `not-supported`.

Each profile also gives three **labels** of its location, the words a client shows people: for one location (the
location argument's title, `Folder`), for a list of them (`Folders`), and for any location the account reaches (`Any
folder you can reach`).

A location is described by `{ ref, title, path?, writable, portable }`. `portable` says whether its reference names
the same place for every account that reaches it (a store that gives folders an identifier of their own) or only for
this account (a store that names a folder by its path in the account's own tree). A client that lets several people
use one location with each person's own account uses portable locations only.

Confinement is the provider's to enforce, since only the service knows what a folder holds. The conformance tests of
every profile check it (FEAT-CORE-012 to 015).

## 7. Pages

A tool that lists, one whose profile gives it `limit` and `cursor`, takes `limit`, 1 to 100 (50 when absent; a
server answers at most its `limits.page`), and `cursor`, a string the previous answer gave as `nextCursor`. An
answer with no `nextCursor` is the last page. A cursor is good for the same arguments only, and for at least ten
minutes; a cursor the server no longer knows is refused (`bad-cursor`). An item neither added nor removed while a
client pages is answered once and once only.

## 8. Time

An instant is a string in the `date-time` form of RFC 3339. The instants a provider answers about an item
(`createdAt`, `modifiedAt`) are in UTC, written with `Z`. A calendar's times are set out in the Calendar profile,
which also names time zones, by their names in the IANA time zone database.

## 9. Errors

A call that the provider refuses or that fails is a tool execution error of MCP: `isError: true`, with
`structuredContent` `{ "error": { "code", "message", … } }` and the same object as JSON in a `text` block. `message`
is one sentence in English that a model can read and relay; it holds no credential, no address of the service and
no name of an item outside the location. Protocol errors of MCP keep their meaning: an unknown tool, a request that
is not well formed.

| `code` | When | More members |
|---|---|---|
| `invalid-argument` | an argument is missing, unknown, of the wrong type or out of its bounds | `field`, the argument's name |
| `not-supported` | an argument or a value that the server did not declare (of a capability, an audience, a search of contents) or that the profile does not take (a part of a `rule`, a type of export the item does not list); an item the operation cannot act on (a folder read as a file) | `field` when an argument is the cause |
| `not-found` | the reference names no item that the location holds, for the account of the call, an item outside the location included | |
| `outside-location` | the operation's destination, given by path, would leave the location (`../HR`, a path that escapes it); never answered to a reference, of the item acted on or of a destination | |
| `already-exists` | an item of this name is already there | |
| `version-mismatch` | `ifVersion` is not the item's version | `currentVersion` |
| `too-large` | the content is larger than the server's limit, or than the service takes | `limitBytes`, and `sizeBytes` when known |
| `permission-denied` | the account may not do this at the service; a question of the service was declined (§4) | |
| `account-refused` | the request carries no credentials, or the service refuses them | |
| `rate-limited` | the service asks to wait | `retryAfterSeconds` when known |
| `unavailable` | the service cannot be reached, or fails | |
| `bad-cursor` | the cursor is unknown, expired, or was given for other arguments | |

A profile may add codes of its own (Files adds `recipient-refused`, files §4.7). A client treats a code it does not know as `unavailable`. The errors a profile
names for a tool are those particular to it: a tool also answers any other code of the table that its arguments or
the service give rise to.

## 10. Effects, people named in a call, content written by others

Each tool of a profile has one **effect**, in the four words of the Ayni Agent (its D99):

| Effect | Means |
|---|---|
| `read` | reads, changes nothing |
| `write` | creates or changes something that the service can show or bring back as it was |
| `delete` | removes something, or changes it beyond what the service can bring back |
| `external` | sends, shares or publishes to people outside the organization |

**People named in a call.** A tool that names people (those a file is shared with, those invited to an event) marks
the arguments that hold their addresses. Its effect is then `write` while every address is inside the organization,
and `external` once one is outside. The provider does not decide which: it knows nothing of the organization. The
client does, before the call, from the addresses the call carries, and the profile gives it the arguments to read.

**Content written by others.** What a provider answers is content, never instructions: a file's name and text, an
event's title and description, an invitation. Each profile says which of its results carry text that people other
than the account's holder may have written, so that a client can treat it as untrusted content (the Ayni Agent's
D99). It marks each tool with one of three words: `no`, the result holds nothing that another person wrote;
`names`, it holds the names, titles and paths of items and the names people go by, which whoever may name an item
writes; `names and content`, it also holds the content of an item, such as a file's text or an event's description.

## 11. Accounts

- A provider takes the account of a call from the HTTP request that carries it, never from an argument, and answers
  no credential in a result or an error.
- A provider that is the service's own (it issues or accepts tokens meant for it) is an OAuth resource server as the
  MCP authorization specification says: Protected Resource Metadata, a bearer token in `Authorization`.
- A **connector** is a provider that fronts a service it is not part of, and holds no account: each request carries
  the account's credentials at the service, in `Authorization` or in headers its documentation names. A connector
  keeps them for the request and no longer, writes them to no log and no store, and sends them to the service of the
  request only. It is run by whoever runs the client, inside the same deployment or behind TLS, and is reachable by
  that client only: a credential given to a connector has left the client, and only an operator who runs both can
  answer for it.
- One request, one account. A provider keeps nothing it read with one account for a request of another.

## 12. Limits

| `limits` member | Meaning | Default | Least a server may declare |
|---|---|---|---|
| `page` | the most items in one page | 100 | 20 |
| `readBytes` | the most bytes of one content read | 10 MiB | 1 MiB |
| `writeBytes` | the most bytes of one content written | 10 MiB | 1 MiB |

Larger contents are for a later version: moving bytes outside the messages of MCP is being drafted by MCP's File
Uploads working group, and the profiles will follow it rather than define their own.

## 13. Conformance

A server **conforms** to a version of a profile when it passes every test of the profile's core and every test of
each capability it declares. The tests are the *Verify* lines of the requirements of this document and of the
profile, run by a client against the server with:

- two accounts of the service, A and B, with their credentials;
- an empty location that A may write to, and a second location that A may read, outside the first;
- for a profile with a capability that names people, an address inside and one outside a test organization;
- for a capability that makes a location owned by the organization (Files' `team-roots`), a third account M that may
  make one.

A run leaves the first location empty. The list of tests is the list of requirements: FEAT-CORE for every profile,
then the profile's own, grouped as the end of its requirements says. A server's conformance is a statement about a
version of the server and a version of the profile; who may make that statement for others, and how it is published,
is left open (the Ayni Agent's O57).

## 14. Versions of a profile

- A **minor** version adds: an optional capability, an optional argument, a member of a result, an error code. It
  removes and renames nothing. A client of 1.0 works with a server of 1.1 and the other way round: each ignores what
  it does not know, within the rules of §4.
- A **major** version may change anything, takes a new identifier (`org.ayni/files-2`) and a new prefix for its
  tools, and may be served beside the former one.
- A published version is never edited. Errors found in it are corrected in the next minor version.

## 15. Requirements

Conventions: [README.md](README.md#conventions). "The server" is a provider that declares a profile.

- **[FEAT-CORE-001]** The server MUST declare each profile it implements under the profile's identifier in `capabilities.extensions`, in the result of `server/discover`, or of `initialize` for an MCP revision that has it, with `version` and `capabilities` as §3 says.
  *Verify:* `server/discover` answers `org.ayni/files` with `version: "1.0"` and a list of capabilities, each a name of the profile.
- **[FEAT-CORE-002]** The server MUST list, in `tools/list`, every core tool of the profile and every tool of each capability it declares, and no tool of a capability it does not declare.
  *Verify:* the names listed with the profile's prefix are exactly the core's and those of the declared capabilities.
- **[FEAT-CORE-003]** The server MUST NOT list a tool whose name begins with a profile's prefix and is not a tool of that profile.
  *Verify:* no listed name with the prefix is unknown to the profile's version.
- **[FEAT-CORE-004]** The `inputSchema` the server lists for a profile's tool MUST accept every input the profile allows for the capabilities declared, and MUST NOT require an argument the profile does not require.
  *Verify:* for each tool, an input that uses each argument the profile allows for the capabilities declared validates against the listed schema, and so does an input with only the required arguments.
- **[FEAT-CORE-005]** The server MUST refuse a call that carries an argument it does not know with `invalid-argument` naming it, and an argument or a value of a capability it did not declare with `not-supported` naming it; it MUST NOT ignore either.
  *Verify:* a call with `colour: "red"` answers `invalid-argument` with `field: "colour"`; a server without `recurrence` answers `not-supported` with `field: "rule"` to an event created with a rule.
- **[FEAT-CORE-006]** Every result of a profile's tool MUST carry `structuredContent` with the members the profile gives for it, and a `text` content block holding the same object as JSON.
  *Verify:* each tool's result validates against the profile's result, and its text parses to the same object.
- **[FEAT-CORE-007]** A call the server refuses or that fails MUST answer `isError: true` with `{ "error": { "code", "message" } }` in both forms, the code one of §9 or of the profile, with the members §9 gives for it; the message MUST hold no credential, no address of the service and nothing of an item outside the location.
  *Verify:* a read of an unknown reference answers `not-found`; with the service stopped, `unavailable`; no error text holds the account's password or the service's URL.
- **[FEAT-CORE-008]** A reference MUST be a string of 1 to 1024 characters that holds no credential and no signed address, and MUST name its item, in every call of the same account, until the item is moved, renamed or deleted.
  *Verify:* a reference read an hour earlier still reads its item; no reference holds the account's secret or a query string with a signature.
- **[FEAT-CORE-009]** An item's `version` MUST change whenever the item changes and MUST NOT be the version of another state of the same item.
  *Verify:* a replace answers a version that differs from the one before; reading twice with no change answers the same version.
- **[FEAT-CORE-010]** An operation that takes `ifVersion` MUST change nothing and answer `version-mismatch` with `currentVersion` when `ifVersion` is not the item's version at the time the server compares.
  *Verify:* a replace with the version read before another replace answers `version-mismatch`, and the content is the other replace's.
- **[FEAT-CORE-011]** A server that declares `atomicWrites: true` MUST compare `ifVersion` and write as one step at the service.
  *Verify:* of two replaces sent together with the same `ifVersion`, one succeeds and the other answers `version-mismatch`, in fifty attempts.
- **[FEAT-CORE-012]** Every tool but the one that lists locations MUST require the profile's location argument, and MUST answer `not-found` to a reference to an item that the location does not hold, as to a reference to no item, with nothing of the item in the answer; it MUST NOT answer `outside-location` to such a reference.
  *Verify:* with A's second location as the argument, a reference of the first location answers `not-found`, as a reference to no item does; the error names no item.
- **[FEAT-CORE-013]** A result MUST NOT hold an item outside the location of its call, and every item of a result MUST carry that location's reference in the member named after the location argument.
  *Verify:* every item of every list, search and read of the test run carries the location of its call.
- **[FEAT-CORE-014]** The server MUST answer `not-found` to a destination given by reference that the location of its call does not hold, MUST refuse with `outside-location` an operation whose destination, given by path, would leave that location, and MUST NOT follow a link kept inside the location to an item outside it.
  *Verify:* a move to a folder of the second location, named by its reference, answers `not-found`, as a read of it does; a destination path that escapes the location (`../HR`) answers `outside-location`; a shortcut to a file of the second location is listed as a link and reading it answers `not-found` or `not-supported`.
- **[FEAT-CORE-015]** The tool that lists locations MUST answer only locations the account of the request reaches, each with `ref`, `title`, `writable` and `portable`.
  *Verify:* A's list holds the two test locations and none of B's own; a location only B reaches is absent.
- **[FEAT-CORE-016]** A tool that lists MUST take `limit` and `cursor` as §7 says, MUST answer `nextCursor` on every page but the last, and MUST answer `bad-cursor` to a cursor it does not know or that was given for other arguments.
  *Verify:* 120 items listed with `limit: 50` come in three pages, each item once; the first page's cursor with another location answers `bad-cursor`.
- **[FEAT-CORE-017]** The instants the server answers about an item MUST be RFC 3339 `date-time` strings in UTC, written with `Z`.
  *Verify:* every `createdAt` and `modifiedAt` of the test run matches `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$`.
- **[FEAT-CORE-018]** The MCP hints of a profile's tool MUST follow its effect: `readOnlyHint` true for `read` and false otherwise, `destructiveHint` true for `delete` and false for `write` and `external`.
  *Verify:* the hints of each listed tool against the profile's table of effects.
- **[FEAT-CORE-019]** The server MUST take the account of a call from the HTTP request alone, MUST refuse a credential given as an argument as any unknown argument, and MUST answer no credential in a result or an error.
  *Verify:* the same call with A's and with B's credentials acts for A and for B; no answer of the test run holds either password or token.
- **[FEAT-CORE-020]** The server MUST NOT answer to a request of one account anything it read with another.
  *Verify:* B's list of a location that A also reaches holds only what B may read there; an item only A may read is absent from every answer to B, also right after A read it.
- **[FEAT-CORE-021]** A connector MUST keep the credentials of a request in memory for that request only, MUST write them to no log and no store, and MUST send them to no host but the service of that request.
  *Verify:* at its most verbose log level a test run leaves neither password nor token in its output or on disk; a stub service is the only host that receives them.
- **[FEAT-CORE-022]** A server MUST answer `too-large`, with `limitBytes`, to a content larger than the limit it declares, and MUST NOT cut a content of bytes.
  *Verify:* a read of an image of `readBytes` plus one byte answers `too-large` with the limit; a create of `writeBytes` plus one byte answers the same and creates nothing.
- **[FEAT-CORE-023]** A server of version 1.x MUST serve a client of 1.0 as 1.0 says: a later minor version removes and renames nothing.
  *Verify:* the tests of 1.0 pass against a server that declares a later 1.x.
- **[FEAT-CORE-024]** A profile's tool MUST complete from its arguments alone unless the service itself asks the person something; the server MUST then pass that question on as an MCP input request of the call, MUST NOT answer it itself, and, when it is declined or cancelled, MUST change nothing and answer `permission-denied`.
  *Verify:* every call of the test run completes with no input request against a service that asks nothing; against a stub service that asks before a write, the call answers an input request, and a decline leaves the item as it was.
- **[FEAT-CORE-025]** What the server declares (§3) MUST be the same for every request of one account, and MAY differ only between accounts.
  *Verify:* ten `server/discover` with A's credentials answer the same declaration, byte for byte; a declaration that differs between A and B differs only by a capability one of the two accounts' plans lacks.
- **[FEAT-CORE-026]** Each member of `limits` the server declares MUST be at least the least of §12, and a page MUST hold at most the smaller of `limit` and `limits.page`; a `limit` outside 1 to 100 MUST answer `invalid-argument`.
  *Verify:* the declared `page`, `readBytes` and `writeBytes` are at least 20, 1 MiB and 1 MiB; with `limits.page: 20`, a list of 30 items asked with `limit: 50` answers 20 and a `nextCursor`; `limit: 0` and `limit: 101` answer `invalid-argument` with `field: "limit"`.
