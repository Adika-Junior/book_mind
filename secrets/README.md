# secrets/

Docker Compose mounts these files as secrets (`/run/secrets/<name>`); the app reads them via the
`*_FILE` environment variables, so no secret ever appears in `docker inspect` or the image.
Everything in this folder except this README is git-ignored.

Create them once:

```bash
./deploy/make-secrets.sh
```

Rotate by overwriting a file and running `docker compose up -d` (the auth password is re-read on
every request, so rotating it needs no restart at all). In Kubernetes use a Secret, or the
External Secrets Operator / Vault Agent injector to sync from HashiCorp Vault or a cloud secrets
manager — see docs/ARCHITECTURE.md §7.
