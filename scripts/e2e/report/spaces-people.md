# End to end: spaces, memories, the employee list, badges from it, invitations

Run 2026-11-19T05:48:50.637Z on commit a78fe9b: **15 passed, 0 failed**.

- Agent: node dist/index.js (stub model), PostgreSQL pgvector/pgvector:pg16, Mailpit axllent/mailpit:v1.32.0.
- Stand-in: DIDComm agent, trust resolver and Verana Graph answered by this script; it plays the phone.
- Not covered: a real VS Agent, a wallet and the ledger: the badge offer is accepted by this script.

| # | Step | Requirements | Result |
|---|------|--------------|--------|
| 1 | A guest connects and links a web session (CHAN-BIND-009) | IDENT-RES-007, CHAN-BIND-009 | passed |
| 2 | The badge is ready before any evidence: its own email check is the action that obtains its claims | INTX-ISSUE-005/006/021 | passed |
| 3 | Issuing ends the turn with the code question in the conversation, nothing on the phone | INTX-AUTH-012 | passed |
| 4 | A listed and an unlisted address get the same answer; only the listed one gets a code | INTX-AUTH-013/014 | passed |
| 5 | A wrong code is a try; the right one verifies the address and the badge is offered by itself | INTX-AUTH-014/015, IDENT-DIR-004/005 | passed |
| 6 | The wallet accepts; the person is told, then asked to present the badge, which identifies them | IDENT-RES-017, IDENT-DIR-006, IDENT-ROLE-012 | passed |
| 7 | Space lifecycle: create, change within bounds, read, activity | SPACE-DEF-001..006, PROF-SPACE-001..004/006 | passed |
| 8 | The member picker and adding a person of the directory | SPACE-MEMB-002/005, PROF-DIR-001, PROF-SPACE-005 | passed |
| 9 | A conversation in the space | SPACE-CONV-001, PROF-CONV-010/011 | passed |
| 10 | A memory added by the working_memory tool: its event, its history line, /memories and /about-me | MEM-SPACE-001..007, PROF-STREAM-010, PROF-HIST-012, PROF-MEM-001/003 | passed |
| 11 | Deleting a message within its window, and window-passed after it | PRIV-ERASE-010..012, PROF-HIST-010 | passed |
| 12 | Handing the conversation over to the space | SPACE-SHARE-001..004, PROF-CONV-012 | passed |
| 13 | Organizations of the trust graph, and an invitation of another organization by email | PROF-DIR-002, SPACE-INV-001/002, PLAT-MAIL-002 | passed |
| 14 | The store holds no code, no typed address and no invited email in the clear | INTX-AUTH-014, SPACE-INV-001, D77 | passed |
| 15 | The agent logged no error | operations | passed |

## Evidence

### 1. A guest connects and links a web session (CHAN-BIND-009)

```json
{
  "session": "ses_cFBgRVgAclS2yDNS",
  "principal": "Unidentified peer",
  "ms": 3323
}
```

### 2. The badge is ready before any evidence: its own email check is the action that obtains its claims

```json
{
  "toolAnswer": "Tool credential_requirements answered: [{\"credential\":\"badge\",\"label\":\"Northwind badge\",\"state\":\"ready\",\"trigger\":\"model\",\"claims\":[{\"name\":\"badgeNumber\",\"status\":\"missing\",\"action\":{\"type\":\"issue_credential\",\"profile\":\"badge\",\"challenge\":\"email\",\"note\":\"when the issuance starts, the system asks the person in this conversation for the email address their organization knows them by, and for the code it sends there; you never see either\" ",
  "ms": 72
}
```

### 3. Issuing ends the turn with the code question in the conversation, nothing on the phone

```json
{
  "question": "To issue your Northwind badge, the agent checks your email address. Which email address does Northwind Logistics know you by? Type it in your next message: the agent's own code reads it, not the AI. Type cancel to stop.",
  "ms": 42
}
```

### 4. A listed and an unlisted address get the same answer; only the listed one gets a code

```json
{
  "answer": "If this address is on the list of Northwind Logistics, a six-digit code was just sent to it. Type the code here: it is valid for 10 minutes.",
  "emailSubject": "Your code for Ayni Agent (dev)",
  "ms": 3915
}
```

### 5. A wrong code is a try; the right one verifies the address and the badge is offered by itself

```json
{
  "emailText": "Your code for Ayni Agent (dev) is 652643.\r\n\r\nIt is valid for 10 minutes. Type it in your conversation with Ayni Agent (dev).\r\n\r\nIf you did not ask for it, ignore this email.\r\n",
  "wrongTry": "That code is not right. 4 tries are left.",
  "rightCode": "Your email address is verified. Your Northwind badge is now offered to your wallet: accept it there.",
  "offer": {
    "connectionId": "conn-jonas",
    "credentialDefinitionId": "def-1",
    "claims": {
      "badgeNumber": "FCE9THM78WSK744T",
      "name": "Jonas Weber",
      "email": "jonas.weber@northwind.example",
      "department": "Depot Rotterdam",
      "birthDate": "",
      "photo": "",
      "phoneNumber": ""
    },
    "autoAccept": true,
    "revocationRegistryDefinitionId": "def-1/revreg-1",
    "revocationRegistryIndex": 0
  },
  "ms": 176
}
```

### 6. The wallet accepts; the person is told, then asked to present the badge, which identifies them

```json
{
  "told": "The credential is in your wallet.",
  "presentationRequests": 1,
  "principal": {
    "displayName": "Jonas Weber",
    "photo": null,
    "backingIdentity": {
      "kind": "org",
      "name": "Northwind Logistics"
    }
  },
  "creatableTemplates": [
    "project",
    "sales",
    "organization"
  ],
  "ms": 256
}
```

### 7. Space lifecycle: create, change within bounds, read, activity

```json
{
  "space": {
    "id": "spc_47mwWm2u2bS3q8Zk",
    "title": "Rotterdam handoff",
    "rules": {
      "handover": true,
      "lawfulBasis": "contract",
      "retentionDays": 90,
      "allowedProviders": [
        "stub",
        "openai-compatible"
      ]
    },
    "members": [
      {
        "memberId": "mem_5c454bDBt0G7CHuV",
        "name": "Jonas Weber",
        "organization": "Northwind Logistics",
        "state": "active",
        "role": "owner"
      }
    ]
  },
  "refusedOutOfBounds": {
    "error": "out-of-bounds",
    "message": "retentionDays is outside the bounds of the template",
    "field": "rules.retentionDays"
  },
  "activity": [
    "rules-changed",
    "created"
  ],
  "ms": 49
}
```

### 8. The member picker and adding a person of the directory

```json
{
  "picker": {
    "people": [
      {
        "directoryId": "p-0042",
        "name": "Ana Ríos",
        "department": "Depot Rotterdam"
      }
    ]
  },
  "added": {
    "memberId": "mem_flkpf1Cm54KaKqKA",
    "name": "Ana Ríos",
    "organization": null,
    "state": "invited",
    "role": "member"
  },
  "ms": 12
}
```

### 9. A conversation in the space

```json
{
  "reply": "You said: What is planned for the night shipments? ",
  "conversations": [
    {
      "id": "conv_Zmf1FLehTjqAD1_L",
      "spaceId": "spc_47mwWm2u2bS3q8Zk"
    }
  ],
  "ms": 253
}
```

### 10. A memory added by the working_memory tool: its event, its history line, /memories and /about-me

```json
{
  "event": {
    "type": "CUSTOM",
    "name": "ayni.memory.updated",
    "value": {
      "conversationId": "conv_Zmf1FLehTjqAD1_L",
      "entryId": "msg_EsU3UQ4htFYtUIaC",
      "memoryId": "note_TVgD5cTTuLbsPcJ_",
      "spaceId": "spc_47mwWm2u2bS3q8Zk",
      "action": "added"
    },
    "timestamp": 1795067315353
  },
  "historyLine": {
    "id": "msg_EsU3UQ4htFYtUIaC",
    "role": "activity",
    "activityType": "ayni.memory-update",
    "content": {
      "memoryId": "note_TVgD5cTTuLbsPcJ_",
      "spaceId": "spc_47mwWm2u2bS3q8Zk",
      "action": "added"
    },
    "metadata": {
      "entryId": "msg_EsU3UQ4htFYtUIaC",
      "createdAt": "2026-11-19T05:48:35.352Z",
      "initiatedAt": "2026-11-19T05:48:35.351Z",
      "sourceType": "state-update"
    }
  },
  "memories": {
    "preferences": [],
    "memories": [
      {
        "id": "note_TVgD5cTTuLbsPcJ_",
        "spaceId": "spc_47mwWm2u2bS3q8Zk",
        "content": "Jonas prefers morning deliveries",
        "createdAt": "2026-11-19T05:48:35.336Z",
        "updatedAt": "2026-11-19T05:48:35.336Z",
        "source": {
          "conversationId": "conv_Zmf1FLehTjqAD1_L",
          "title": "What is planned for the night shipments?"
        }
      }
    ]
  },
  "aboutMe": {
    "preferences": [],
    "memoriesBySpace": [
      {
        "spaceId": "spc_47mwWm2u2bS3q8Zk",
        "title": "Rotterdam handoff",
        "count": 1
      }
    ],
    "conversations": [
      {
        "spaceId": "spc_47mwWm2u2bS3q8Zk",
        "title": "Rotterdam handoff",
        "count": 1,
        "retentionDays": 90
      },
      {
        "spaceId": "personal:prn_l6BhqSBuEMpnB-wx",
        "title": "Personal",
        "count": 1,
        "retentionDays": 365
      }
    ],
    "verified": [
      {
        "label": "email",
        "source": "email",
        "verifiedAt": "2026-11-19T05:48:34.600Z",
        "expiresAt": "2026-12-19T05:48:34.600Z"
      },
      {
        "label": "authentication",
        "source": "Northwind Logistics",
        "verifiedAt": "2026-11-19T05:48:34.863Z",
        "expiresAt": null
      }
    ]
  },
  "ms": 103
}
```

### 11. Deleting a message within its window, and window-passed after it

```json
{
  "deletedReply": "You said: This message goes ",
  "deleted": 204,
  "late": {
    "error": "window-passed"
  },
  "ms": 9355
}
```

### 12. Handing the conversation over to the space

```json
{
  "shared": {
    "shared": true,
    "sharedAt": "2026-11-19T05:48:44.763Z",
    "conversationId": "conv_Zmf1FLehTjqAD1_L",
    "spaceId": "spc_47mwWm2u2bS3q8Zk"
  },
  "list": {
    "conversations": [
      {
        "id": "conv_Zmf1FLehTjqAD1_L",
        "title": "What is planned for the night shipments?",
        "author": {
          "name": "Jonas Weber"
        },
        "sharedAt": "2026-11-19T05:48:44.763Z",
        "lastActivityAt": "2026-11-19T05:48:35.731Z"
      }
    ]
  },
  "ms": 23
}
```

### 13. Organizations of the trust graph, and an invitation of another organization by email

```json
{
  "organizations": {
    "organizations": [
      {
        "organizationKey": "org:FR:111",
        "name": "Acme Freight",
        "country": "FR"
      }
    ]
  },
  "refused": {
    "error": "not-on-verana",
    "message": "this organization is not found trusted in the trust graph"
  },
  "member": {
    "memberId": "mem_nyUG-pkpHnSRilmU",
    "name": "marc.petit@acme.example",
    "organization": "Acme Freight",
    "state": "invited",
    "role": "guest"
  },
  "subject": "Jonas Weber invites you to \"Rotterdam handoff\" with Ayni Agent (dev)",
  "text": "Jonas Weber invites you to the space \"Rotterdam handoff\" of Ayni Agent (dev), the agent of Northwind Logistics.\r\n\r\nTo join, connect to Ayni Agent (dev) with the Ayni app and authenticate with a badge issued by Acme Freight that carries this address, marc.petit@acme.example. This link opens the agent in the Ayni app:\r\n\r\nhttps://app.dev.ayni.org/app/service/did:webvh:QmE2eAgent:agent.northwind.example\r\n\r\nThe link opens nothing by itself: the space opens to the badge of your organization that carries this address.\r\n",
  "ms": 59
}
```

### 14. The store holds no code, no typed address and no invited email in the clear

```json
{
  "tables": 20,
  "sealed": {
    "code": [],
    "typedAddress": [],
    "unlistedAddress": [],
    "invitedEmail": []
  },
  "verifiedAddressAlsoIn": [
    "principals"
  ],
  "ms": 5801
}
```

### 15. The agent logged no error

```json
{
  "lines": 50,
  "warnings": [
    "identity: the authentication lets guests in: user agents enter unidentified until they authenticate (D53, D72)",
    "OBJECT_STORE_ENDPOINT not set: media objects are kept in memory (development only)",
    "system-prompt add-on exceeds its 500-token target (CORE-PROMPT-004)",
    "rag source unreadable"
  ],
  "ms": 0
}
```

