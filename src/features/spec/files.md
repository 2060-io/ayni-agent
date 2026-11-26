# Ayni Feature Profile: Files 1.0

> **Status:** DRAFT, **normative** for a provider that declares `org.ayni/files`.
> **Identifier:** `org.ayni/files` · **Version:** `1.0` · **Prefix:** `files_` · **Location argument:** `root`, a folder.
> **Location's labels** (common §6): one location `Folder`; a list of them `Folders`; any location `Any folder you can reach`.
> **Companions:** the [common part](common.md), which this profile builds on and does not repeat.

Files is the feature of a store of files and folders: a drive, a share, a document library. The core is what
WebDAV (RFC 4918) gives any client, so that a plain WebDAV server can be a whole provider; what only some stores
have is in optional capabilities.

---

## 1. Items

An **item** is a file or a folder. Every tool answers items in this shape:

| Member | Type | | Meaning |
|---|---|---|---|
| `ref` | string | always | the item's reference (common §5) |
| `root` | string | always | the reference of the root of the call |
| `kind` | `file`, `folder` or `link` | always | `link`: a shortcut to an item elsewhere, never followed |
| `name` | string | always | its name in its folder, with its extension |
| `path` | string | always | where it is under the root, for people to read: `/` for the root itself, `/Reports/Q3.md`; never a reference |
| `parent` | string | except for the root | the reference of the folder that holds it |
| `mediaType` | string | a file | its media type (RFC 6838), `application/octet-stream` when the store knows none |
| `sizeBytes` | integer | a file, when known | its size |
| `version` | string | a file | its version (common §5) |
| `createdAt`, `modifiedAt` | instant | when known | |
| `modifiedBy` | string | when known | a name to show, never an address |
| `native` | boolean, always `true` | only on a native document | a document of the store's own format that has no bytes of its own: it is read as text (§1, Content) and exported (§4.6); absent on every other item, never `false` |
| `shared` | boolean, always `true` | capability `share`, only on a shared item | the item has a share made on it, or on a folder between the root and it: people other than those who reach the root reach it (§4.4); a share made on the root, or above it, does not count; absent on every other item, never `false` |
| `trashedAt` | instant | capability `trash`, an item of the trash | when it was moved to the trash |
| `exportTypes` | list of media types | capability `export`, a file the store converts | the types `files_export` gives it in |
| `webUrl` | string | when the store has one | the address at which a person opens the item in the store's own interface |

A name is 1 to 255 characters, holds no `/` and no control character, and is neither `.` nor `..`; a store's own
limits come on top (`invalid-argument`, `field: "name"`). Whether two names that differ only by case are one name is
the store's rule. Two items of one folder never have the same name: a provider of a store that allows it refuses to
create the second (`already-exists`) and lists those it finds as they are.

**Content.** A content is read and written in one of two forms:

| Form | Shape | When |
|---|---|---|
| text | `{ "kind": "text", "text", "mediaType" }` | a file whose media type is `text/*`, `application/json`, `application/xml` or ends in `+json` or `+xml`, decoded as UTF-8 (a byte order mark removed); and a `native` document, given as the text the store exports for it, with that export's media type (`text/markdown` where the store has it, else `text/plain`) |
| bytes | `{ "kind": "bytes", "base64", "mediaType" }` | every other file, whole, in base64 (RFC 4648) |

**Content written by others** (common §10). An item's `name`, `path` and `modifiedBy` are written by whoever may
name the item or a folder above it; a file's content and a search's `snippet`, by whoever may change the file. The
tables of §3 and §4 say, for each tool, what its result carries: `no`, `names` or `names and content`.

## 2. Roots

A root is a folder that the operations are confined to (common §6). `files_roots` lists the folders an account may
be given as a root; every other tool takes `root`. A root is described by `{ ref, title, path, writable, portable,
team? }`: `team`, present and `true` only on a team root (§4.7).

## 3. Core operations

Six tools. Every provider has all of them. The description of each tool, under its heading, is what a client gives
the model, word for word.

| Tool | Title | Effect | Result carries content written by others |
|---|---|---|---|
| `files_roots` | List folders to work in | `read` | names |
| `files_list` | List a folder | `read` | names |
| `files_get` | Look at a file or a folder | `read` | names |
| `files_read` | Read a file | `read` | names and content |
| `files_create` | Create a file | `write` | names |
| `files_replace` | Replace a file's content | `write` | names |

### 3.1 `files_roots`

*Description:* "List the folders you can work in. Give the start of a path to narrow the list."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `query` | Path begins with | string, 1 to 200 characters | optional | a text to narrow the list |
| `limit` | Most results | | optional | common §7 |
| `cursor` | Next page | | optional | common §7 |

Result: `{ "roots": [ { "ref", "title", "path", "writable", "portable", "team"? } ], "nextCursor"? }`. With no
`query`: the top of the account, first the account's own folder (`path: "/"`), then the other places the account
reaches at that level (a shared drive, a library, a team root). With a `query`: at least the folders whose `path`
begins with the text, taken as a path whose last part may be unfinished (`/Proj` answers `/Projects`,
`/Projects/Al` answers `/Projects/Alpha`); a provider whose store searches folders by name MAY add those it finds
anywhere.

### 3.2 `files_list`

*Description:* "List what a folder holds, one level only, without the content of its files. With no folder, list the
top of the folder you work in."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `root` | Folder | reference | required | the location (common §6) |
| `folder` | Folder to list | reference | optional | the folder to list; the root when absent |
| `limit` | Most results | | optional | common §7 |
| `cursor` | Next page | | optional | common §7 |

Result: `{ "folder": Item, "items": [Item], "nextCursor"? }`. Errors: `not-found`, `not-supported` when `folder` is
a file or a link.

### 3.3 `files_get`

*Description:* "Look at one file or folder: its name, path, type, size, version and dates, without its content."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `root` | Folder | reference | required | |
| `ref` | Item | reference | required | the item |

Result: `{ "item": Item }`. Errors: `not-found`.

### 3.4 `files_read`

*Description:* "Read a file's content: a text file, or a document of the store's own, as text; any other file as its
bytes. Give maxBytes to read only the start of a long text."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `root` | Folder | reference | required | |
| `ref` | File | reference | required | the file |
| `maxBytes` | Most bytes of text | integer, 1 or more | optional | the most bytes of text to answer; the server's `readBytes` when absent or larger |

Result: `{ "item": Item, "content": Content, "truncated"? }`. A text longer than `maxBytes` is cut at a character
and answered with `truncated: true`, a member present only then; bytes are never cut (`too-large`). Errors:
`not-found`, `not-supported` for a folder or a link, `too-large`.

### 3.5 `files_create`

*Description:* "Create a new file with its content in a folder. Nothing is written if an item of that name is already
there, and no folder is created on the way."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `root` | Folder | reference | required | |
| `folder` | In folder | reference | optional | the folder to create it in; the root when absent |
| `name` | Name | string | required | the file's name |
| `content` | Content | `{ "text" }` or `{ "base64" }` | required | the content, as text or as bytes |
| `mediaType` | Type | string | optional | its media type; from the name's extension when absent, else `text/plain` for a text and `application/octet-stream` for bytes |

Result: `{ "item": Item }`. The provider stores the content as given: it converts nothing to a format of the
store's own. It creates no folder on the way. Errors: `already-exists`, `not-found` for the folder, `invalid-argument`
for the name, `too-large`, `permission-denied`.

### 3.6 `files_replace`

*Description:* "Replace the whole content of an existing file. Give the version you read: if the file changed since,
nothing is written and the current version comes back."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `root` | Folder | reference | required | |
| `ref` | File | reference | required | the file |
| `ifVersion` | Version read | string | required | the version the caller read (common §5) |
| `content` | New content | `{ "text" }` or `{ "base64" }` | required | the new content |
| `mediaType` | Type | string | optional | its media type; the file's own when absent |

Result: `{ "item": Item }`, with the new version. It never creates a file, and it changes neither the name nor the
folder. For a `native` document, the provider replaces the document's content with the text given, where the store
converts it, and refuses otherwise (`not-supported`). Errors: `version-mismatch`, `not-found`, `not-supported` for a
folder or a link, `too-large`, `permission-denied`.

Replacing is a `write`, not a `delete`: the call names the version it replaces, so nothing is overwritten that the
caller did not read. A provider with the capability `versions` also keeps the former content.

## 4. Optional capabilities

| Capability | Tools | Adds to core tools |
|---|---|---|
| `search` | `files_search` | |
| `folders` | `files_create_folder`, `files_move` | |
| `trash` | `files_trash`, `files_restore`, `files_list_trash` | `trashedAt` on an item of the trash |
| `share` | `files_shares`, `files_share`, `files_unshare` | `shared` on an item |
| `versions` | `files_versions` | `version` as an argument of `files_read` |
| `export` | `files_export` | `exportTypes` on an item |
| `team-roots` | `files_create_team_root`, `files_rename_root`; requires `share` | `team` on a root; members of a team root through the tools of `share` |

| Tool | Title | Effect | Result carries content written by others |
|---|---|---|---|
| `files_search` | Search files | `read` | names and content |
| `files_create_folder` | Create a folder | `write` | names |
| `files_move` | Move or rename | `write` | names |
| `files_trash` | Move to the trash | `delete` | names |
| `files_restore` | Restore from the trash | `write` | names |
| `files_list_trash` | List the trash | `read` | names |
| `files_shares` | See who a file is shared with | `read` | names |
| `files_share` | Share | `write`; `external` when it names an address outside the organization, or `audience: "anyone"` | names |
| `files_unshare` | Stop sharing | `write` | names |
| `files_versions` | List a file's versions | `read` | names |
| `files_export` | Read a file in another format | `read` | names and content |
| `files_create_team_root` | Create a team's folder | `write` | no |
| `files_rename_root` | Rename a team's folder | `write` | no |

### 4.1 `search`

`files_search`. *Description:* "Find files and folders by words in their name, their content, or either. Plain
words only: no search operators."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `root` | Folder | reference | required | |
| `query` | Words | string, 1 to 200 characters | required | plain words: no operator of any store is read in it |
| `folder` | In folder | reference | optional | narrows the search to that folder and what it holds |
| `in` | Search in | `name`, `content` or `any` | optional | `any` when absent |
| `limit` | Most results | | optional | common §7 |
| `cursor` | Next page | | optional | common §7 |

Result: `{ "items": [Item + "snippet"?], "nextCursor"? }`, `snippet` being a few words of the content around a match,
present only on an item found by its content. A provider whose store does not search content declares `"search": {
"content": false }` beside its capabilities and refuses `in: "content"` (`not-supported`). The results are inside the
root, whatever the store's own search reaches.

### 4.2 `folders`

`files_create_folder`. *Description:* "Create a folder inside a folder."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `root` | Folder | reference | required | |
| `folder` | In folder | reference | optional | the folder to create it in; the root when absent |
| `name` | Name | string | required | the folder's name, under the rules of a name (§1) |

Result: `{ "item" }`. Errors: `already-exists`, `not-found` for the folder, `invalid-argument` for the name.

`files_move`. *Description:* "Move a file or a folder to another folder, rename it, or both. A folder moves with what
it holds. The item's reference changes: use the one this answers."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `root` | Folder | reference | required | |
| `ref` | Item | reference | required | the item to move or rename |
| `toFolder` | To folder | reference | optional | the folder it goes to |
| `newName` | New name | string | optional | its new name |
| `ifVersion` | Version read | string | optional | for a file, the version the caller read |

Result: `{ "item" }`, with the reference the item has afterwards. One of `toFolder` and `newName` at least
(`invalid-argument` otherwise); the destination is inside the root (a `toFolder` the root does not hold answers
`not-found`; a destination whose path would leave the root answers `outside-location`); a folder moves with what it
holds, and never into itself (`invalid-argument`); `already-exists` when the destination holds that name. The root
itself is not moved or renamed by `files_move` (`not-supported`).

### 4.3 `trash`

`files_trash`. *Description:* "Move a file or a folder to the trash. It can be restored for as long as the store keeps
its trash."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `root` | Folder | reference | required | |
| `ref` | Item | reference | required | the item to move to the trash |
| `ifVersion` | Version read | string | optional | for a file, the version the caller read |

Result: `{ "item" }` with `trashedAt`. The item leaves its folder; a folder goes with what it holds. The root itself is
not trashed (`not-supported`).

`files_restore`. *Description:* "Bring an item back from the trash to the folder it left."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `root` | Folder | reference | required | |
| `ref` | Item | reference | required | an item of the trash |

Result: `{ "item" }`, back in the folder it left. Errors: `already-exists` when that folder now holds the name,
`not-found` when the folder it left is gone or the item is not in the trash.

`files_list_trash`. *Description:* "List the items in the trash that came from the folder you work in."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `root` | Folder | reference | required | |
| `limit` | Most results | | optional | common §7 |
| `cursor` | Next page | | optional | common §7 |

Result: `{ "items", "nextCursor"? }`, the trashed items that were inside the root, each with `trashedAt`.

No tool removes an item for good (FEAT-FILES-011): a provider of a store with no trash has no way to remove one.

### 4.4 `share`

A share gives people access to an item at the store. Roles are two: `reader` and `editor`, and `manager` on a team
root only (§4.7). A provider maps each to the nearest of the store's own that gives no more.

`files_shares`. *Description:* "See who a file or a folder is shared with, and how."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `root` | Folder | reference | required | |
| `ref` | Item | reference | required | the item |

Result: `{ "shares": [Share] }`.

`files_share`. *Description:* "Share a file or a folder with people, by their email addresses, or with an audience,
as a reader or an editor."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `root` | Folder | reference | required | |
| `ref` | Item | reference | required | the item to share |
| `role` | Role | `reader`, `editor` (`manager` on a team root, §4.7) | required | |
| `recipients` | People | list of 1 to 20 `{ "address" }`, email addresses | one of `recipients` and `audience` | the people the item is shared with; the argument that names people (common §10) |
| `audience` | Audience | `organization` or `anyone` | one of `recipients` and `audience` | everyone in the account's organization at the store, or whoever has the link |
| `notify` | Tell them | boolean | optional, where the provider declares `notify: true` | lets the store tell the recipients; true when absent |
| `message` | Message | string, up to 1000 characters | optional, where the provider declares `notify: true` | sent with the store's message |

Result: `{ "shares": [Share] }`, the shares it made.

`files_unshare`. *Description:* "Stop one share of a file or a folder."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `root` | Folder | reference | required | |
| `ref` | Item | reference | required | the item |
| `share` | Share | string | required | the `id` of one of the item's shares |

Result: `{ "shares": [Share] }`, those that remain. A share with `inherited: true` is ended on the folder it comes from,
not here (`not-supported`).

Share: `{ "id", "role", "recipient"?: { "address", "name"? }, "audience"?, "link"?, "inherited" }`; `inherited` is
true for a share that comes from a folder above, which is ended there.

A provider declares `"share": { "audiences": [ … ], "notify": true|false }`: the audiences its store has, and
whether it can tell recipients. With `notify: false`, `notify` and `message` belong to nothing the provider declared
(`not-supported`), and nobody is told. `recipients[].address` is the argument that names people (common §10), from
which a client takes the effect of the call (§4). A share of a team root is a membership of it (§4.7).

### 4.5 `versions`

`files_versions`. *Description:* "List the former versions of a file, newest first. Read one by giving its version to
the read of the file."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `root` | Folder | reference | required | |
| `ref` | File | reference | required | the file |
| `limit` | Most results | | optional | common §7 |
| `cursor` | Next page | | optional | common §7 |

Result: `{ "versions": [ { "version", "modifiedAt", "modifiedBy"?, "sizeBytes"? } ], "nextCursor"? }`, newest first.
`files_read` then takes `version` (title "Version", a string, optional): the version to read, the current one when
absent. A former content is brought back by reading it and replacing with it.

### 4.6 `export`

An item carries `exportTypes`, the media types the store can give it in.

`files_export`. *Description:* "Read a file converted to another format, one of the formats the file lists."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `root` | Folder | reference | required | |
| `ref` | File | reference | required | the file |
| `mediaType` | Format | string | required | one of the item's `exportTypes` |

Result: `{ "item", "content" }`, in a type of that list (`not-supported` otherwise), under the limits of `files_read`.

### 4.7 `team-roots`

A **team root** is a root that belongs to the organization at the store, not to a person: a shared drive, a team
folder, a group's document library. Nobody's own folder holds it, and it stays when any one person leaves. Its
**members** are the people the store lets reach it, each with a role: `reader`, `editor` or, where the store has
one, `manager`, who may also change its members and its name. A client that keeps a team's folder for a group of
people creates one with this capability and keeps its members with the tools of `share` (the Ayni Agent's D145). A
provider that declares `team-roots` MUST declare `share`.

`files_create_team_root`. *Description:* "Create a folder that belongs to the organization, for a team."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `name` | Name | string, 1 to 100 characters, under the rules of a name (§1) | required | the name people read |
| `requestId` | Request | string, 1 to 128 characters of `A-Z a-z 0-9 - _` | required | the same request sent again answers the same root and creates no second one |

Result: `{ "root": Root }`, `team: true`, `portable: true`. The account of the call becomes the root's first member,
as a `manager` where the store has the role and as the account the store lets manage it otherwise. Two team roots may
have the same name. Errors: `permission-denied` (the store does not let the account create one), `invalid-argument`.

`files_rename_root`. *Description:* "Rename a team's folder."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `root` | Folder | reference | required | a team root |
| `name` | New name | string, 1 to 100 characters, under the rules of a name | required | |

Result: `{ "root": Root }`. A root that is not a team root answers `not-supported`; an account that may not manage
it, `permission-denied`.

**Members, through `share`.** On a team root, called with the root's own reference as `ref`:

- `files_share` with `recipients` makes each a member with `role`; with `audience`, it answers `not-supported`;
- `files_shares` lists the members, one Share each, `inherited: false`;
- `files_unshare` ends a membership; a member is changed to another role by sharing again with the new role, which
  replaces the former one;
- an address the store cannot make a member answers `recipient-refused`, with `reason`: `no-account` (the address is
  no account of the store), `not-allowed` (the store's administrator does not let the root take that address, such
  as one outside the organization) or `too-many` (the root holds as many members as the store allows).

A provider declares `"team-roots": { "manager": true|false }`: whether its store has the role `manager`; with
`false`, `role: "manager"` answers `not-supported`.

## 5. What Files 1.0 leaves out

Removing for good; copying; comments; locks; a file's own properties and labels; changes since a date and
notifications of change; contents above the limits and partial reads or writes (common §12); the store's own
document formats beyond reading them as text; renaming a root that is not a team root; deleting a team root.

## 6. Checked against

The core was checked against the public documentation of four stores, so that none of its tools is impossible for
one of them. What each connector does and declares is in [providers.md](providers.md).

| Core | WebDAV (RFC 4918), Nextcloud | Google Drive API v3 | Microsoft Graph (OneDrive, SharePoint) |
|---|---|---|---|
| `files_roots` | `PROPFIND` `Depth: 1` on collections | `files.list` of folders, `drives.list` | `GET /me/drive/root/children`, `GET /me/drives`, sites' libraries |
| `files_list` | `PROPFIND` `Depth: 1` | `files.list` with `'<id>' in parents and trashed = false` | `GET …/items/{id}/children` |
| `files_get` | `PROPFIND` `Depth: 0` | `files.get` | `GET …/items/{id}` |
| `files_read` | `GET` | `files.get` with `alt=media`; `files.export` for a document of Google's own | `GET …/items/{id}/content`; `?format=` for a conversion |
| `files_create` | `PUT` with `If-None-Match: *` | `files.create` with an upload, after a look for the name (not one step) | an upload session (`createUploadSession`) with `@microsoft.graph.conflictBehavior: fail` |
| `files_replace` | `PUT` with `If-Match` | `files.update` with an upload, after comparing `headRevisionId`: `files.update` takes no precondition, so not one step | an upload session opened with `If-Match` on the item's `eTag` |
| Reference | the path under the account's folder (changes at a rename); for a Nextcloud, the file id | the file's id | the item's id |
| Version | the entity tag (`getetag`); where a server gives none, the last change and the length | `headRevisionId`, or `version` for a document of Google's own | `eTag` |
| Inside the root | the path is the root's, or begins with the root's followed by `/`; for a Nextcloud, a search for the file id under the root | each parent in turn up to the root (a file has one parent) | `parentReference.path` |
| `atomicWrites` | true with entity tags | false | true |
| `portable` roots | no: a path in the account's own tree; yes for a Nextcloud, by its file id | yes | yes |

| `team-roots` | Nextcloud | Google Drive API v3 | Microsoft Graph |
|---|---|---|---|
| A team root | a team folder (the app formerly named group folders), set up through its administration interface, reached by members through a group | a shared drive, `drives.create` with a `requestId`; its creator becomes its manager (`organizer`) | the document library of a Microsoft 365 group (`POST /groups`, `groupTypes: ["Unified"]`), whose creator becomes an owner |
| Its members | the members of the groups the folder is given to, each group with its permissions | permissions on the shared drive (`permissions.create` with the drive's id, `supportsAllDrives`) | the group's members and owners |
| Renaming it | its mount point | `drives.update` | the group's name |

Two findings shaped the profile. Plain WebDAV has no search (RFC 5323 adds one, which Nextcloud serves): search is a
capability, and the core lists. Google Drive compares no version on a write: `atomicWrites` is declared, not
assumed. Capabilities each store can back: `folders` all four (`MKCOL` and `MOVE`; parents and names; `PATCH`);
`search` Nextcloud, Drive and Graph; `trash`, `share` and `versions` Drive and Graph, and Nextcloud through its own
interfaces beyond WebDAV; `export` Drive and Graph; `team-roots` Drive, Graph and Nextcloud, never a plain WebDAV
server, which has no owner but a person's account.

The experimental draft of MCP's Filesystems working group ([README](README.md)) has operations on MCP Resources
close to this core. Files 1.0 keeps the same two rules, create only if absent and write only on a matching version,
so that a later version can sit on those methods if they become part of MCP.

## 7. Requirements

FEAT-CORE applies whole. "The server" declares `org.ayni/files` `1.0`; A, B and the two locations are those of
common §13.

**Core**

- **[FEAT-FILES-001]** The server MUST expose `files_roots`, `files_list`, `files_get`, `files_read`, `files_create` and `files_replace`, with the arguments and results of §3.
  *Verify:* the six tools are listed, and a call of each, with the arguments of §3, answers the members §3 gives.
- **[FEAT-FILES-002]** Every item the server answers MUST carry `ref`, `root`, `kind`, `name` and `path`, a file also `mediaType` and `version`, and every item but the root `parent`.
  *Verify:* every item of the test run has them; the root's `path` is `/`.
- **[FEAT-FILES-003]** `files_roots` with no `query` MUST answer the top of the account, the account's own folder first, and with a `query` MUST answer at least the folders whose path begins with it, the last part taken as unfinished.
  *Verify:* with folders `/Projects/Alpha` and `/Projects/Beta`, `/Projects/Al` answers Alpha and not Beta; no query answers `/` first.
- **[FEAT-FILES-004]** `files_list` MUST answer the items the folder holds directly, each once over the pages, and none below.
  *Verify:* a folder with two files and a folder that holds a third file lists three items.
- **[FEAT-FILES-005]** `files_read` MUST answer a text for a file of a text media type and for a `native` document, and whole bytes in base64 for any other file, in the shapes of §1.
  *Verify:* a `notes.md` written as text reads back the same text; a PNG reads back the same bytes; a document of the store's own reads as text with `native: true`.
- **[FEAT-FILES-006]** `files_read` MUST cut a text longer than `maxBytes` at a character and say `truncated: true`, and MUST NOT cut bytes.
  *Verify:* a text of 3,000 bytes read with `maxBytes: 1000` answers at most 1,000 bytes of valid UTF-8 and `truncated: true`.
- **[FEAT-FILES-007]** `files_create` MUST create the file with the content as given, and MUST answer `already-exists`, changing nothing, when the folder holds an item of that name.
  *Verify:* a created file reads back byte for byte; a second create of the same name answers `already-exists` and the first content stays.
- **[FEAT-FILES-008]** `files_create` MUST refuse a name that is empty, longer than 255 characters, `.` or `..`, or that holds `/` or a control character, with `invalid-argument` and `field: "name"`, and MUST create no folder on the way.
  *Verify:* `a/b.txt` answers `invalid-argument`; a create in a folder that does not exist answers `not-found` and creates nothing.
- **[FEAT-FILES-009]** `files_replace` MUST require `ifVersion`, MUST replace the whole content when it is the file's version, MUST answer the item with a new version, and MUST change neither the name nor the folder.
  *Verify:* a replace with the version just read succeeds and the file reads back the new content at the same path; a replace with no `ifVersion` answers `invalid-argument`.
- **[FEAT-FILES-010]** `files_replace` MUST NOT create a file: an unknown reference answers `not-found`.
  *Verify:* a replace of a reference that names nothing answers `not-found` and the folder is as before.
- **[FEAT-FILES-011]** A tool of Files 1.0 MUST NOT remove an item for good, and a core tool MUST NOT remove one at all.
  *Verify:* after every core call of the test run, each item created is still listed.
- **[FEAT-FILES-012]** A `link` MUST be listed as a link and MUST NOT be read, listed or written through.
  *Verify:* in a store that has shortcuts, a shortcut to a file outside the root lists as `link`; reading it answers `not-supported` or `not-found`.
- **[FEAT-FILES-013]** `files_list` MUST answer `not-supported` for a `folder` that is a file or a link, and `files_get` MUST answer the root itself, with `path: "/"` and no `parent`, when given the root's reference.
  *Verify:* `files_list` with a file as `folder` answers `not-supported`; `files_get` of the root answers an item of kind `folder`, `path` `/`, without `parent`.
- **[FEAT-FILES-014]** A text read MUST be decoded as UTF-8 with a byte order mark removed, and a file created with no `mediaType` MUST take the type of its name's extension, else `text/plain` for a text and `application/octet-stream` for bytes.
  *Verify:* a file whose bytes begin with `EF BB BF` reads back without the mark; `notes.md` created as text reads `text/markdown`, `notes` created as text `text/plain`, `blob` created as bytes `application/octet-stream`.
- **[FEAT-FILES-015]** `native` MUST be present, `true`, on a native document only, and absent on every other item; `modifiedBy` MUST hold a name, never an address.
  *Verify:* no item of the test run carries `native: false`; a document of the store's own carries `native: true`; no `modifiedBy` of the test run holds an `@`.
- **[FEAT-FILES-016]** `files_replace` MUST answer `not-supported` for a folder, a link, and a `native` document whose content the store does not convert from text, and MUST keep the file's own media type when `mediaType` is absent.
  *Verify:* a replace of a folder answers `not-supported`; a text file replaced with no `mediaType` keeps its type; against a store that converts no text into its documents, a replace of a native document answers `not-supported` and the document is as it was.
- **[FEAT-FILES-017]** Where the store lets two items of one folder have the same name, the server MUST list each of them and MUST refuse to create another of that name with `already-exists`.
  *Verify:* in a folder that holds two files named `a.txt`, made by other means, `files_list` answers both with two references, and `files_create` of `a.txt` answers `already-exists`.

**`search`**

- **[FEAT-FILES-020]** `files_search` MUST answer only items inside the root, MUST read no operator of the store in `query`, and MUST refuse `in: "content"` with `not-supported` when it declares `content: false`.
  *Verify:* a word that names a file of each test location answers only the one inside the root; a query that holds the store's own operator for another folder finds nothing outside the root.
- **[FEAT-FILES-021]** With `folder`, `files_search` MUST answer only that folder and what it holds; with `in: "name"` it MUST find by name only; and a `snippet` MUST be present only on an item found by its content.
  *Verify:* a word in two files, one under `/A` and one under `/B`, with `folder` `/A` answers the first only; a word found only in a file's text answers nothing with `in: "name"`; no item found by its name carries `snippet`.

**`folders`**

- **[FEAT-FILES-030]** `files_create_folder` MUST create the folder or answer `already-exists`, and `files_move` MUST answer the item with the reference it has afterwards.
  *Verify:* a file moved and renamed is read by the reference the move answered, and no longer listed in the folder it left.
- **[FEAT-FILES-031]** `files_move` MUST answer `not-found` to a `toFolder` the root does not hold, and MUST refuse a destination whose path would leave the root with `outside-location`, a folder moved into itself with `invalid-argument`, and a name the destination already holds with `already-exists`.
  *Verify:* each of the four, with nothing moved.
- **[FEAT-FILES-032]** `files_create_folder` MUST refuse a name as `files_create` does, and `files_move` MUST refuse a call with neither `toFolder` nor `newName` with `invalid-argument`, a move of the root with `not-supported`, and an `ifVersion` that is not the file's with `version-mismatch`.
  *Verify:* a folder named `..` answers `invalid-argument`; a move with no destination answers `invalid-argument`; a move of the root answers `not-supported`; a move of a file with the version it had before a replace answers `version-mismatch` and the file stays.
- **[FEAT-FILES-033]** A folder moved MUST keep what it holds, each item reachable under its new path.
  *Verify:* `/A` holding `x.md`, moved into `/B`, lists `x.md` at `/B/A/x.md`, which reads back its content.

**`trash`**

- **[FEAT-FILES-040]** `files_trash` MUST take the item out of its folder into the store's trash, from which `files_restore` MUST bring it back as it was, and `files_list_trash` MUST list only trashed items that were inside the root.
  *Verify:* a trashed file is absent from its folder and present in the trash list; restored, it reads back the same content at the same path.
- **[FEAT-FILES-041]** A folder trashed MUST take what it holds with it; `files_trash` MUST refuse the root with `not-supported` and an `ifVersion` that is not the file's with `version-mismatch`; `files_restore` MUST answer `already-exists` when the folder it left now holds the name, restoring nothing.
  *Verify:* after trashing `/A`, its file is listed nowhere under the root, and restoring `/A` brings both back; trashing the root answers `not-supported`; a trash with an old version answers `version-mismatch`; a file trashed, then a new file of its name created, answers `already-exists` to its restore.
- **[FEAT-FILES-042]** Every item `files_list_trash` answers MUST carry `trashedAt`, and an item restored MUST no longer be listed there.
  *Verify:* the trash list after one trash holds the item with an instant; after its restore the list no longer holds it.

**`share`**

- **[FEAT-FILES-050]** `files_share` MUST take exactly one of `recipients` and `audience`, MUST give no more than the role asked, and MUST answer the shares it made; `files_unshare` MUST end the share named.
  *Verify:* a `reader` share to B lets B read and not replace; after `files_unshare`, B's read answers `not-found` or `permission-denied`.
- **[FEAT-FILES-051]** The server MUST refuse an `audience` it does not declare with `not-supported`, and MUST NOT share with anyone the call does not name.
  *Verify:* `audience: "anyone"` on a server that declares only `organization` answers `not-supported`; after a share to B, `files_shares` lists B and no other new share.
- **[FEAT-FILES-052]** `files_shares` MUST answer every share of the item in the Share shape, `inherited: true` on a share that comes from a folder above, and `files_unshare` MUST answer `not-supported` for such a share, ending nothing.
  *Verify:* a folder shared with B, holding a file: the file's shares list B with `inherited: true`, and unsharing it there answers `not-supported`; unsharing it on the folder ends B's access to both.
- **[FEAT-FILES-053]** A server that declares `notify: true` MUST tell the recipients only when `notify` is true or absent, with `message` where given; one that declares `notify: false` MUST refuse `notify` and `message` with `not-supported` and tell nobody.
  *Verify:* against a store that mails, a share to B with `notify: false` sends B nothing and one with `message: "Q3"` sends a mail that holds it; against a server that declares `notify: false`, a share with `notify: true` answers `not-supported`.
- **[FEAT-FILES-054]** An item MUST carry `shared: true` while it has a share made on it or on a folder between the root and it, and no `shared` otherwise; a share made on the root MUST NOT make the items it holds `shared`.
  *Verify:* a file shared with B lists `shared: true`, and after the share ends, no `shared`; with the root itself shared with B, its files carry no `shared`.
- **[FEAT-FILES-055]** `files_share` MUST refuse `recipients` empty or longer than 20 with `invalid-argument`, `field: "recipients"`, and a `role` it does not take with `not-supported`.
  *Verify:* 21 addresses answer `invalid-argument`; `role: "manager"` on an item that is not a team root answers `not-supported`.

**`versions`, `export`**

- **[FEAT-FILES-060]** `files_versions` MUST list a file's versions newest first, and `files_read` with a listed `version` MUST answer the content of that version.
  *Verify:* after two replaces, three versions are listed and the oldest reads back the first content.
- **[FEAT-FILES-061]** `files_export` MUST answer the content in the type asked when the item's `exportTypes` lists it, and `not-supported` otherwise.
  *Verify:* a document of the store's own exports as `application/pdf` when listed; `image/gif` answers `not-supported`.
- **[FEAT-FILES-062]** `files_read` with a `version` the file never had MUST answer `not-found`, and `files_versions` MUST page as common §7 says.
  *Verify:* a made-up version answers `not-found`; a file replaced sixty times lists its versions with `limit: 50` in two pages, each version once.
- **[FEAT-FILES-063]** `files_export` MUST answer `too-large` with `limitBytes` for an export larger than the server's `readBytes`, and a `native` document MUST carry `exportTypes`.
  *Verify:* every `native` item of the test run carries a list; against a stub whose export of a document exceeds `readBytes`, `files_export` answers `too-large`.

**`team-roots`**

Its tests run with a third account M of the service, one that may create team roots, and A and B as members.

- **[FEAT-FILES-070]** A server that declares `team-roots` MUST declare `share`, and `files_create_team_root` MUST create a root that no person's own folder holds, with `team: true` and `portable: true`, of which the account of the call is a member that may manage it; the same `requestId` sent again MUST answer the same root and create no other.
  *Verify:* M creates `Project Alpha`; `files_roots` of M lists it with `team: true`; sent again with the same `requestId`, the answer has the same `ref` and M's list holds one such root; `server/discover` lists `share` beside `team-roots`.
- **[FEAT-FILES-071]** On a team root, `files_share` with `recipients` MUST make each a member with the role asked, who then reaches the whole root with that role and no more; `files_shares` MUST list each member once; `files_unshare` MUST end the membership; a share with a new role MUST replace the member's former one; and `audience` MUST answer `not-supported`.
  *Verify:* M makes A an `editor` and B a `reader`: A creates a file in the root and B reads it, B's create answers `permission-denied`; B shared again as `editor` creates; after `files_unshare` of B, B's `files_roots` no longer lists the root and B's read answers `not-found`; `audience: "organization"` on the root answers `not-supported`.
- **[FEAT-FILES-072]** An address the store cannot make a member of a team root MUST answer `recipient-refused` with its `reason` (`no-account`, `not-allowed`, `too-many`), adding nobody.
  *Verify:* an address that is no account of the test store answers `recipient-refused` with `reason: "no-account"`; against a store whose administrator forbids addresses outside, an outside address answers `reason: "not-allowed"`; the members listed are as before.
- **[FEAT-FILES-073]** `files_rename_root` MUST rename a team root, keeping its reference and its members, and MUST answer `not-supported` for any other root and `permission-denied` for an account that may not manage it.
  *Verify:* M renames `Project Alpha` to `Alpha`: A's `files_roots` lists `Alpha` with the same `ref`; A, an editor, renaming it answers `permission-denied`; renaming A's own folder answers `not-supported`.
- **[FEAT-FILES-074]** A server that declares `"team-roots": { "manager": false }` MUST refuse `role: "manager"` with `not-supported`; one that declares `true` MUST let a `manager` change the members and the name.
  *Verify:* against each kind of server, `role: "manager"` for A either answers `not-supported`, or lets A add B and rename the root.

**Conformance.** Core: FEAT-CORE-001 to 026 and FEAT-FILES-001 to 017. Each capability: its group above (`search`
020 and 021; `folders` 030 to 033, with FEAT-CORE-014 for moves; `trash` 040 to 042; `share` 050 to 055; `versions`
060 and 062; `export` 061 and 063; `team-roots` 070 to 074, with the tests of `share`).

| Rule | Its test |
|---|---|
| §1 the members of an item, `native`, `shared`, `modifiedBy`, a name's rules, two items of one name | FEAT-FILES-002, 015, 054, 008, 017 |
| §1 the two forms of a content, the byte order mark, a type from the extension | FEAT-FILES-005, 014 |
| §3.1 to §3.6, each tool's result and errors | FEAT-FILES-001, 003, 004, 006 to 010, 013, 016, with FEAT-CORE-007, 012 and 022 |
| §4.1 to §4.7, each capability | the groups above |
| §4.3, no removal for good | FEAT-FILES-011 |
| a link never followed | FEAT-FILES-012, FEAT-CORE-014 |
