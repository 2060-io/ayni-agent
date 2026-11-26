# Ayni Feature Profile: Calendar 1.0

> **Status:** DRAFT, **normative** for a provider that declares `org.ayni/calendar`.
> **Identifier:** `org.ayni/calendar` · **Version:** `1.0` · **Prefix:** `calendar_` · **Location argument:** `calendar`, a calendar.
> **Location's labels** (common §6): one location `Calendar`; a list of them `Calendars`; any location `Any calendar you can reach`.
> **Companions:** the [common part](common.md), which this profile builds on and does not repeat.

Calendar is the feature of events in calendars. Its members are those of iCalendar (RFC 5545), under plainer names,
and its core is what CalDAV (RFC 4791) requires of every server, so that a plain CalDAV server can be a whole
provider; inviting people, answering invitations, repeating events, other people's busy time and meeting links are
optional capabilities.

---

## 1. Events

Every tool answers events in this shape. The third column is the iCalendar property a member is read from and
written to.

| Member | Type | iCalendar | | Meaning |
|---|---|---|---|---|
| `ref` | string | the resource, and `RECURRENCE-ID` for one occurrence | always | the event's reference (common §5) |
| `calendar` | string | | always | the reference of the calendar of the call |
| `uid` | string | `UID` | when the service gives it | the identifier the event has in every calendar that holds it |
| `title` | string | `SUMMARY` | always | may be empty |
| `description` | string | `DESCRIPTION` | when it has one | plain text; a service that keeps marked-up text gives its text |
| `place` | string | `LOCATION` | when it has one | where it takes place |
| `allDay` | boolean | `VALUE=DATE` | always | |
| `start`, `end` | date-time, or date when `allDay` | `DTSTART`, `DTEND` (or `DURATION`) | always | `end` is the first moment, or the first day, after the event |
| `timeZone` | string | `TZID` | when the event has one | a name of the IANA time zone database |
| `status` | `confirmed`, `tentative`, `cancelled` | `STATUS` | always | `confirmed` when the service says nothing |
| `busy` | boolean | `TRANSP` (`OPAQUE` is busy) | always | whether the event takes the time |
| `organizer` | `{ "address"?, "name"? }` | `ORGANIZER` | when it has one | |
| `mine` | boolean | | always | whether the account organizes the event, or the event has no organizer |
| `attendees` | list of Attendee | `ATTENDEE` | when it has some | |
| `recurring` | boolean | `RRULE`, `RECURRENCE-ID` | always | whether it is an occurrence of a series, or a series |
| `series` | string | | an occurrence | the reference of its series |
| `rule` | string | `RRULE` | a series, when read by its own reference | the rule, as §4.2 writes it |
| `meeting` | `{ "url", "label"? }` | `CONFERENCE` (RFC 7986), or the service's own | when it has one | the link of an online meeting |
| `webUrl` | string | `URL`, or the service's own | when the service has one | where a person opens the event in the service's own interface |
| `createdAt`, `modifiedAt` | instant | `CREATED`, `LAST-MODIFIED` | when known | |
| `version` | string | the entity tag | always | its version (common §5) |

Attendee: `{ "address", "name"?, "response", "optional"?, "self"? }`, from `ATTENDEE` with its `CN`, `PARTSTAT`
(`needs-action`, `accepted`, `tentative`, `declined`) and `ROLE` (`OPT-PARTICIPANT` is optional); `optional` and
`self` are present, `true`, only when they hold: `self` marks the account's own line. An address is an email address,
without `mailto:`.

**Times.** A timed event's `start` and `end` are RFC 3339 `date-time` strings with their offset
(`2026-11-23T10:00:00+01:00`), and `timeZone` names the zone the event was set in. An all-day event's are RFC 3339
`full-date` strings (`2026-11-23`), `end` being the day after its last day. A time the calendar keeps with no zone
(iCalendar's floating time) is read in the calendar's own time zone. A provider that writes iCalendar gives each zone
it names its definition (`VTIMEZONE`), or writes the time in UTC when the call gives no `timeZone`.

**Occurrences.** A repeating event is read as its occurrences: `calendar_list_events` answers each occurrence in the
time asked as an event of its own, with `recurring: true`, its own `ref` and the `series` it belongs to.

**Content written by others** (common §10). An event's `title`, `description`, `place`, `organizer`, attendees'
names and `meeting` are written by its organizer, who may be anyone who invites the account; a calendar's `title` and
`description`, by whoever may name it. The tables of §3 and §4 say, for each tool, what its result carries: `no`,
`names` or `names and content`.

## 2. Calendars

A calendar is the location of this profile (common §6). `calendar_calendars` lists the calendars an account
reaches: `{ "ref", "title", "description"?, "timeZone"?, "writable", "portable", "primary"? }`, `primary` present,
`true`, only on the account's own main calendar. Every other tool takes `calendar` and acts on that calendar's events
only.

## 3. Core operations

Six tools. Every provider has all of them. The description of each tool, under its heading, is what a client gives
the model, word for word.

| Tool | Title | Effect | Result carries content written by others |
|---|---|---|---|
| `calendar_calendars` | List calendars | `read` | names |
| `calendar_list_events` | List events | `read` | names and content: an invitation is written by its organizer |
| `calendar_get_event` | Look at an event | `read` | names and content |
| `calendar_create_event` | Add an event | `write`; `external` when it invites an address outside the organization (§4.3) | names |
| `calendar_update_event` | Change an event | `write`; `external` likewise | names |
| `calendar_cancel_event` | Cancel an event | `delete` | no |

### 3.1 `calendar_calendars`

*Description:* "List the calendars you can use. Give a text to keep those whose title holds it."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `query` | Title holds | string, 1 to 200 characters | optional | narrows the list to the calendars whose title holds the text, whatever the case of ASCII letters |
| `limit` | Most results | | optional | common §7 |
| `cursor` | Next page | | optional | common §7 |

Result: `{ "calendars": [Calendar], "nextCursor"? }`.

### 3.2 `calendar_list_events`

*Description:* "List the events of a calendar between two times, each occurrence of a repeating event on its own.
Give a text to keep the events whose title, description or place holds it."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `calendar` | Calendar | reference | required | the location (common §6) |
| `from` | From | date-time | required | the start of the time asked |
| `to` | To | date-time | required | its end: an event is in it when it starts before `to` and ends after `from`; `to` is after `from`, and at most 366 days after |
| `query` | Text | string, 1 to 200 characters | optional | keeps the events whose title, description or place holds the text, whatever the case of ASCII letters |
| `limit` | Most results | | optional | common §7 |
| `cursor` | Next page | | optional | common §7 |

Result: `{ "events": [Event], "nextCursor"? }`, by `start`, then by `ref`. Occurrences of repeating events are
answered one by one (§1). Events that were cancelled and that the service no longer shows are absent.

### 3.3 `calendar_get_event`

*Description:* "Look at one event. Given a repeating event's own reference, it answers the series once, with its
rule."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `calendar` | Calendar | reference | required | |
| `ref` | Event | reference | required | an event, an occurrence or a series |

Result: `{ "event": Event }`. Read by the reference of a series, a repeating event is answered once, with its `rule`
and the `start` and `end` of its first occurrence. Errors: `not-found`.

### 3.4 `calendar_create_event`

*Description:* "Add an event to a calendar. Give a time zone for an event that repeats."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `calendar` | Calendar | reference | required | |
| `title` | Title | string, up to 1024 characters | required | |
| `start` | Starts | date-time, or date with `allDay` | required | |
| `end` | Ends | date-time, or date with `allDay` | required | after `start` |
| `allDay` | All day | boolean | optional | false when absent |
| `timeZone` | Time zone | string | optional | the zone the event is set in; required with a `rule` on a timed event |
| `description` | Description | string | optional | plain text |
| `place` | Place | string | optional | plain text |
| `busy` | Shows as busy | boolean | optional | true when absent |
| `rule` | Repeats | string | capability `recurrence` | §4.2 |
| `attendees` | Invited | | capability `attendees` | §4.3 |
| `notify` | Send invitations | | capability `attendees` | §4.3 |
| `meeting` | Online meeting | boolean | capability `meeting` | §4.5 |

Result: `{ "event": Event }`. Errors: `invalid-argument` (a time, an `end` not after `start`, an unknown time zone, a
title longer than 1024 characters), `not-supported`, `permission-denied` for a calendar that is not `writable`.

### 3.5 `calendar_update_event`

*Description:* "Change an event you organize. Only the members you give change; an empty description or place
removes it. Give the version you read to change nothing if the event changed since."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `calendar` | Calendar | reference | required | |
| `ref` | Event | reference | required | |
| `ifVersion` | Version read | string | optional | the version the caller read (common §5) |
| `title`, `start`, `end`, `allDay`, `timeZone`, `description`, `place`, `busy` | as in §3.4 | | optional | `start` and `end` both or neither |
| `rule`, `attendees`, `notify`, `meeting` | as in §3.4 | | of their capabilities | |
| `scope` | Applies to | `this` or `series` | capability `recurrence` | §4.2 |

A member that is absent stays as it is; an empty `description` or `place` removes it. Result: `{ "event": Event }`.

Only an event the account organizes can be changed (`mine`): another person's event answers `permission-denied`,
and what an attendee may change is their own answer (§4.4). Without the capability `recurrence`, an occurrence or a
series answers `not-supported`. Errors also: `version-mismatch`, `not-found`.

### 3.6 `calendar_cancel_event`

*Description:* "Cancel an event you organize. Those invited are told where the calendar sends invitations. A
cancelled event cannot be brought back."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `calendar` | Calendar | reference | required | |
| `ref` | Event | reference | required | |
| `ifVersion` | Version read | string | optional | the version the caller read |
| `notify` | Tell those invited | boolean | capability `attendees` | §4.3 |
| `comment` | Message | string, up to 1000 characters | capability `attendees` | §4.3 |
| `scope` | Applies to | `this` or `series` | capability `recurrence` | §4.2 |

Result: `{ "cancelled": true, "ref" }`. The event leaves the calendar, or stays in it marked `cancelled`, as the
service does; with the capability `attendees`, those invited are told. The same rules as a change: only an event the
account organizes, and an occurrence or a series only with `recurrence`.

Cancelling is a `delete`: Calendar 1.0 has no way to bring a cancelled event back.

## 4. Optional capabilities

| Capability | Tools | Adds to core tools |
|---|---|---|
| `free-busy` | `calendar_free_busy` | |
| `recurrence` | | `rule` on a creation and a change; `scope` on a change, a cancellation and an answer |
| `attendees` | | `attendees` and `notify` on a creation and a change; `notify` and `comment` on a cancellation |
| `respond` | `calendar_respond` | |
| `meeting` | | `meeting` on a creation and a change |

| Tool | Title | Effect | Result carries content written by others |
|---|---|---|---|
| `calendar_free_busy` | See when people are busy | `read` | no |
| `calendar_respond` | Answer an invitation | `write` | names and content |

### 4.1 `free-busy`

`calendar_free_busy`. *Description:* "See when a calendar, and other people, are busy between two times, without
anything of their events."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `calendar` | Calendar | reference | required | |
| `from` | From | date-time | required | as in §3.2 |
| `to` | To | date-time | required | after `from`, at most 62 days after |
| `people` | People | list of 1 to 20 email addresses | optional | asks the service for other people's busy time |

Result: `{ "calendar": { "busy": [ { "start", "end" } ] }, "people"?: [ { "address", "known", "busy": [ … ] } ] }`.
`busy` holds the times taken, merged and in order, and nothing of any event. `known: false` says that the service
could not tell for an address, which is not an error.

### 4.2 `recurrence`

`rule` is the value of an iCalendar `RRULE` (RFC 5545 §3.3.10), without its name: `FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10`.
Calendar 1.0 takes the part that the calendars checked in §6 all keep: `FREQ` among `DAILY`, `WEEKLY`, `MONTHLY`
and `YEARLY`; `INTERVAL`; `BYDAY` (days of the week for a weekly rule; one day with its rank, such as `2TU` or
`-1FR`, for a monthly or yearly one); `BYMONTHDAY` (one day); `BYMONTH` (one month); and one of `COUNT` and `UNTIL`
at most. Any other part answers `not-supported` with `field: "rule"`. A creation with a `rule` makes a series; its
occurrences then read as §1 says.

`scope` (title "Applies to") says what a change, a cancellation or an answer made with the reference of an occurrence
applies to: `this`, that occurrence alone (the default), or `series`, every occurrence. Made with the reference of a
series, it applies to the series. A change of `rule` is of the series only: given with an occurrence's reference and
`scope: "this"`, it answers `invalid-argument` with `field: "rule"`. There is no "this and the following ones" in 1.0.

### 4.3 `attendees`

`attendees` (title "Invited") is the whole list of the people invited, up to 100 `{ "address", "name"?, "optional"?
}`; on a change it replaces the list. `notify` (title "Send invitations" on a creation and a change, "Tell those
invited" on a cancellation; true when absent) lets the service send the invitations, the changes and the
cancellation to them; `comment` (title "Message"), on a cancellation, is a line sent with it. The provider sends
nothing itself: a service with no scheduling of its own cannot have this capability.

`attendees[].address` is the argument that names people (common §10), from which a client takes the effect of a
creation or a change (§3).

### 4.4 `respond`

`calendar_respond`. *Description:* "Answer an invitation to an event you are invited to: accept, maybe, or decline."

| Argument | Title | Type | | Meaning |
|---|---|---|---|---|
| `calendar` | Calendar | reference | required | |
| `ref` | Event | reference | required | |
| `response` | Answer | `accepted`, `tentative` or `declined` | required | the answer of the account |
| `comment` | Message | string, up to 1000 characters | optional | sent to the organizer with the answer |
| `notify` | Tell the organizer | boolean | optional | true when absent |
| `scope` | Applies to | `this` or `series` | capability `recurrence` | §4.2 |

Result: `{ "event": Event }`. An event the account organizes, or is not invited to, answers `not-supported`.

### 4.5 `meeting`

`meeting: true` asks the service for a meeting link of its own for the event; `false`, on a change, removes it. The
event then carries `meeting`. A provider declares `"meeting": { "label": "…" }`, the name people know the service's
meetings by. An event read from any provider carries `meeting` when it has one, whatever the provider declares.

## 5. What Calendar 1.0 leaves out

Reminders and alarms; an event's visibility; categories and colours; attachments; rooms and resources; "this and
the following ones"; proposing another time; tasks; creating, renaming or deleting a calendar; moving an event to
another calendar; working hours; changes since a date and notifications of change.

## 6. Checked against

What each connector does and declares is in [providers.md](providers.md).

| Core | CalDAV (RFC 4791), Nextcloud | Google Calendar API v3 | Microsoft Graph (Outlook) |
|---|---|---|---|
| `calendar_calendars` | the principal's `calendar-home-set`, then `PROPFIND` `Depth: 1` | `calendarList.list` | `GET /me/calendars` |
| `calendar_list_events` | `calendar-query` with a `time-range`, which every server must serve and match repeating events against | `events.list` with `timeMin`, `timeMax`, `singleEvents=true`, `q` | `GET …/calendars/{id}/calendarView` |
| `calendar_get_event` | `GET` of the resource | `events.get` | `GET …/events/{id}` |
| `calendar_create_event` | `PUT` with `If-None-Match: *` | `events.insert` | `POST …/calendars/{id}/events` |
| `calendar_update_event` | `GET`, change, `PUT` with `If-Match` | `events.patch` with `If-Match` | `PATCH …/events/{id}` |
| `calendar_cancel_event` | `DELETE` with `If-Match` | `events.delete` | `DELETE …/events/{id}`, or `cancel` for an event with attendees |
| Reference | the resource's path, and the occurrence's `RECURRENCE-ID` | the event's `id` (an occurrence has its own) | the event's `id` |
| Version | the entity tag, which CalDAV requires strong | `etag` | `changeKey` |
| `query` | a `text-match`, or kept by the provider from what the time holds | `q` | kept by the provider from what the time holds |
| `portable` calendars | no: a path in the account's own tree | yes: a calendar has one id for every account it is shared with | a group's calendar only: a calendar shared between mailboxes has an id of its own in each |

| Capability | CalDAV | Google Calendar | Microsoft Graph |
|---|---|---|---|
| `free-busy` | `free-busy-query` for the calendar, required of every server; other people through scheduling (RFC 6638) | `freebusy.query` | `getSchedule` |
| `recurrence` | `RRULE` and overriding components in one resource | `recurrence`, and occurrences by their own `id` | `recurrence`, in Graph's own pattern, to and from the rule |
| `attendees` | only a server with scheduling (RFC 6638), which sends | `attendees` with `sendUpdates` | `attendees`; Outlook sends |
| `respond` | only with scheduling: the account's own `PARTSTAT` | the account's `responseStatus` | `accept`, `tentativelyAccept`, `decline` |
| `meeting` | none: no service to make a link | `conferenceData`, Google Meet | `isOnlineMeeting`, Teams |

Three findings shaped the profile. Neither Google nor Microsoft names an event by its iCalendar `UID` in its
interface: the reference is the provider's own, and `uid` is given beside it when the service has it. Microsoft
Graph keeps a repetition in a pattern of its own, not as a rule: the profile takes the part of `RRULE` that this
pattern can hold. CalDAV alone invites nobody: a plain CalDAV server stores `ATTENDEE` lines and sends nothing unless
it implements scheduling, so inviting is a capability and not part of the core.

## 7. Requirements

FEAT-CORE applies whole. "The server" declares `org.ayni/calendar` `1.0`; A and B are the accounts of common §13,
and the two locations are two calendars.

**Core**

- **[FEAT-CAL-001]** The server MUST expose `calendar_calendars`, `calendar_list_events`, `calendar_get_event`, `calendar_create_event`, `calendar_update_event` and `calendar_cancel_event`, with the arguments and results of §3.
  *Verify:* the six tools are listed, and a call of each, with the arguments of §3, answers the members §3 gives.
- **[FEAT-CAL-002]** Every event the server answers MUST carry `ref`, `calendar`, `title`, `allDay`, `start`, `end`, `status`, `busy`, `mine`, `recurring` and `version`.
  *Verify:* every event of the test run has them.
- **[FEAT-CAL-003]** A timed event's `start` and `end` MUST be RFC 3339 `date-time` strings with an offset, and an all-day event's `full-date` strings, `end` being the first moment or day after the event.
  *Verify:* an event created 10:00 to 11:00 in `Europe/Paris` on a winter day reads back `…T10:00:00+01:00` and `…T11:00:00+01:00` with `timeZone: "Europe/Paris"`; an all-day event of one day reads back that day and the next.
- **[FEAT-CAL-004]** `calendar_list_events` MUST answer every event of the calendar that starts before `to` and ends after `from`, and no other, ordered by `start` then `ref`, and MUST refuse a `to` that is not after `from` or is more than 366 days after it with `invalid-argument`.
  *Verify:* of three events, before, across the start of, and after the time asked, the second alone is answered; a span of 400 days answers `invalid-argument` with `field: "to"`.
- **[FEAT-CAL-005]** `calendar_list_events` MUST answer each occurrence of a repeating event within the time as an event of its own, with `recurring: true`, a `ref` of its own and its `series`, whether or not the server declares `recurrence`.
  *Verify:* a weekly series put in the calendar by other means lists four occurrences over four weeks, each with another `ref` and the same `series`.
- **[FEAT-CAL-006]** With a `query`, `calendar_list_events` MUST keep the events whose title, description or place holds the text, whatever the case of ASCII letters.
  *Verify:* `budget` finds "Budget review" and an event whose place is "Budget room", and not "Planning".
- **[FEAT-CAL-007]** `calendar_create_event` MUST create one event with the members given, and the event MUST read back as given.
  *Verify:* the title, the times, the zone, the description, the place and `busy: false` of a created event read back the same.
- **[FEAT-CAL-008]** `calendar_update_event` MUST change the members given and no other, MUST take `start` and `end` together only, and MUST remove a `description` or a `place` given empty.
  *Verify:* a change of the title leaves the times and the place; `start` alone answers `invalid-argument`; `place: ""` reads back with no `place`.
- **[FEAT-CAL-009]** `calendar_update_event` and `calendar_cancel_event` MUST refuse an event the account does not organize with `permission-denied`, changing nothing.
  *Verify:* B's invitation in A's calendar: A's change and A's cancellation each answer `permission-denied`, and B's event is as it was.
- **[FEAT-CAL-010]** After `calendar_cancel_event`, the event MUST be absent from `calendar_list_events`, or be listed with `status: "cancelled"`.
  *Verify:* a cancelled event is not listed, or is listed as cancelled; reading it answers `not-found`, or the event with `status: "cancelled"`.
- **[FEAT-CAL-011]** A server that does not declare `recurrence` MUST refuse a `rule`, and a change or a cancellation of an occurrence or a series, with `not-supported`.
  *Verify:* a creation with `rule` answers `not-supported` with `field: "rule"`; a change of a listed occurrence answers `not-supported`.
- **[FEAT-CAL-012]** `calendar_calendars` with a `query` MUST answer the calendars whose title holds the text, whatever the case of ASCII letters, and only those; `primary` MUST be present, `true`, on the account's main calendar alone; a creation in a calendar that is not `writable` MUST answer `permission-denied`.
  *Verify:* `team` finds "Team Alpha" and not "Personal"; exactly one calendar of A's list carries `primary`, none carries `primary: false`; a creation in a calendar shared with A to read answers `permission-denied`.
- **[FEAT-CAL-013]** `calendar_get_event` with the reference of a series MUST answer the series once, with its `rule` and the `start` and `end` of its first occurrence, and with an occurrence's reference that occurrence.
  *Verify:* a weekly series read by its `series` answers its rule and the first Monday; one of its listed occurrences read by its `ref` answers that day.
- **[FEAT-CAL-014]** A creation MUST take `allDay` false and `busy` true when absent, MUST refuse an `end` not after `start`, an unknown time zone and a title longer than 1024 characters with `invalid-argument`, and an event read with no `STATUS` MUST read `status: "confirmed"`.
  *Verify:* an event created with only a title and two times reads `allDay: false`, `busy: true`, `status: "confirmed"`; `end` equal to `start` answers `invalid-argument` with `field: "end"`; `timeZone: "Mars/Olympus"` answers `invalid-argument` with `field: "timeZone"`.
- **[FEAT-CAL-015]** A time kept with no zone MUST be read in the calendar's own time zone, and a timed event created with no `timeZone` MUST be written in UTC.
  *Verify:* a floating 09:00 event, put by other means in a calendar of `Europe/Paris`, reads `…T09:00:00+01:00` in winter; an event created at `2026-11-23T10:00:00+01:00` with no zone reads back the same instant, with no `timeZone`.
- **[FEAT-CAL-016]** `calendar_cancel_event` MUST answer `{ "cancelled": true, "ref" }`, and a change or a cancellation with an `ifVersion` that is not the event's MUST answer `version-mismatch` and change nothing.
  *Verify:* a cancellation answers the event's reference; a change with the version read before another change answers `version-mismatch` and the event keeps the other change.
- **[FEAT-CAL-017]** Every attendee the server answers MUST carry `address` without `mailto:` and `response` among the four of §1, `self` only on the account's own line and `optional` only on an optional one.
  *Verify:* B's invitation read by A lists A's line with `self: true` and B's address as `b@…`, with no `mailto:`; no attendee of the test run carries `self: false` or `optional: false`.

**`free-busy`**

- **[FEAT-CAL-020]** `calendar_free_busy` MUST answer the times taken in the calendar within the time asked, merged and in order, with nothing of any event, and for each address of `people` its times or `known: false`.
  *Verify:* two events that overlap answer one time; no title is in the answer; an address the service does not know answers `known: false`.
- **[FEAT-CAL-021]** `calendar_free_busy` MUST refuse a `to` more than 62 days after `from` with `invalid-argument`, and `people` empty or longer than 20 likewise.
  *Verify:* 63 days answer `invalid-argument` with `field: "to"`; 21 addresses answer `invalid-argument` with `field: "people"`.

**`recurrence`**

- **[FEAT-CAL-030]** The server MUST take a `rule` within §4.2, refuse any other part with `not-supported` and `field: "rule"`, and require `timeZone` with a `rule` on a timed event.
  *Verify:* `FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6` lists six occurrences on Mondays and Wednesdays; `FREQ=SECONDLY` answers `not-supported`; a rule with no `timeZone` answers `invalid-argument`.
- **[FEAT-CAL-031]** A change or a cancellation made with an occurrence's reference MUST apply to that occurrence alone unless `scope` is `series`.
  *Verify:* one occurrence moved by an hour leaves the others; cancelled with `scope: "series"`, none is listed.
- **[FEAT-CAL-032]** An occurrence's wall-clock time MUST follow its `timeZone` across a change of offset.
  *Verify:* a weekly 10:00 `Europe/Paris` series across the last Sunday of March reads `+01:00` before and `+02:00` after, both at 10:00.
- **[FEAT-CAL-033]** A change of `rule` MUST apply to the series, and MUST be refused with `invalid-argument` and `field: "rule"` when made with an occurrence's reference and `scope: "this"`; a change made with a series' own reference MUST apply to every occurrence.
  *Verify:* the rule of a weekly series changed by its `series` to `COUNT=2` lists two occurrences; the same change with an occurrence's `ref` and no `scope` answers `invalid-argument`; a change of the title by the series' reference renames every occurrence.

**`attendees`**

- **[FEAT-CAL-040]** `attendees` on a change MUST replace the list, and with `notify` true the service MUST send the invitation, the change or the cancellation to those invited, and with `notify` false send nothing.
  *Verify:* B receives the invitation of an event created with B and `notify` true, and nothing for one created with `notify: false`; a change with an empty list leaves no attendee.
- **[FEAT-CAL-041]** The server MUST invite nobody the call does not name.
  *Verify:* after a creation that names B, the event's attendees are B and, where the service adds the organizer, A.
- **[FEAT-CAL-042]** A cancellation with `comment` MUST send that line with the cancellation, `optional: true` on an attendee MUST read back, and more than 100 attendees MUST be refused with `invalid-argument`.
  *Verify:* B's cancellation message holds the comment given; B invited as optional reads back `optional: true`; 101 attendees answer `invalid-argument` with `field: "attendees"`.

**`respond`, `meeting`**

- **[FEAT-CAL-050]** `calendar_respond` MUST set the account's own answer to an event it is invited to, and MUST answer `not-supported` for any other event.
  *Verify:* A's `declined` to B's invitation reads back on A's line and, with `notify` true, reaches B; on A's own event it answers `not-supported`.
- **[FEAT-CAL-051]** `calendar_respond` with `notify: false` MUST NOT tell the organizer, and, with `recurrence`, an answer made with an occurrence's reference MUST apply to that occurrence alone unless `scope` is `series`.
  *Verify:* A's `accepted` with `notify: false` reads back on A's line and B receives nothing; A's `declined` to one occurrence of B's weekly series leaves A's answer to the others as it was.
- **[FEAT-CAL-060]** With `meeting: true`, the event MUST carry a `meeting` whose `url` opens a meeting of the service, and with `meeting: false` on a change MUST carry none.
  *Verify:* a created event carries an `https` address of the service's meetings; after the change it carries no `meeting`.
- **[FEAT-CAL-061]** A server that declares `meeting` MUST declare its `label`, and every server MUST answer an event's `meeting` when the event has one, whether or not it declares the capability.
  *Verify:* `server/discover` of a server with `meeting` carries `"meeting": { "label": … }`; an event with a `CONFERENCE` property, put by other means in a calendar of a server without `meeting`, reads back its `meeting`.

**Conformance.** Core: FEAT-CORE-001 to 026 and FEAT-CAL-001 to 017. Each capability: its group above
(`free-busy` 020 and 021; `recurrence` 030 to 033; `attendees` 040 to 042; `respond` 050 and 051; `meeting` 060 and
061).

| Rule | Its test |
|---|---|
| §1 the members of an event, its attendees, its times, floating times, occurrences | FEAT-CAL-002, 017, 003, 015, 005 |
| §2 the calendars, `primary`, `writable` | FEAT-CAL-012, FEAT-CORE-015 |
| §3.1 to §3.6, each tool's result and errors | FEAT-CAL-001, 004, 006 to 010, 012 to 014, 016, with FEAT-CORE-007, 010 and 012 |
| §4.1 to §4.5, each capability | the groups above, and FEAT-CAL-011 for a server without `recurrence` |
