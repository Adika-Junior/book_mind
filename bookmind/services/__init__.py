# SPDX-License-Identifier: AGPL-3.0-or-later
"""BookMind microservices. Each module exposes an ASGI `app`:

  gateway   — edge API gateway + PWA host (the only public service)
  catalog   — owns the book content (documents, pages, glossary)       [read-only data]
  search    — BM25 passage index + notebook read model (CQRS query side)
  research  — retrieval-augmented generation via a local model, with extractive fallback
  notebook  — owns notes (SQLite write model) and publishes changes via a transactional outbox
"""
