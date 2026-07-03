# Updating Nova-MES in Kubernetes

This release adds a **PostgreSQL** component plus a `DATABASE_URL` env var on `mes-web`.
It is **not** a simple image bump — the database must exist before the new `mes-web`
pods start, or they will log `db init failed, continuing without DB` and the new
Dashboard / Batch Records / Deviations pages will show empty states.

> Registry: `us-central1-docker.pkg.dev/sales-engineering-emea/nova-mes/nova-mes`
> Cluster: GKE `dp-apps-2` · Namespace: `nova-mes`

---

## 0. Prerequisites (one-time)

```bash
# Authenticate to GKE
gcloud container clusters get-credentials dp-apps-2 \
  --region <region> --project sales-engineering-emea

# Authenticate Docker to Artifact Registry
gcloud auth configure-docker us-central1-docker.pkg.dev

# Confirm you're pointed at the right cluster
kubectl config current-context
kubectl get ns nova-mes
```

---

## 1. Build and push the new image

The `pg` dependency was added to `services/mes-web/package.json`, so the image must be
rebuilt. All services share one image.

```bash
cd /Users/dan.pedrosa/Git/nova-mes

# Tag with a version AND latest (immutable tag lets you roll back cleanly)
IMAGE=us-central1-docker.pkg.dev/sales-engineering-emea/nova-mes/nova-mes
TAG=$(date +%Y%m%d-%H%M)

# GKE nodes are linux/amd64 — build for that platform explicitly
docker buildx build --platform linux/amd64 \
  -t $IMAGE:$TAG -t $IMAGE:latest --push .
```

> If CI (`.github/workflows`) builds the image on push to `main`, you can instead commit
> and let the pipeline build/push, then use the SHA/tag it produces.

---

## 2. Deploy — choose Helm OR raw manifests

### Path A — Helm (recommended; postgres = durable StatefulSet + PVC)

```bash
# Dry-run first: confirms the new postgres.yaml renders and mes-web gets DATABASE_URL
helm upgrade nova-mes ./helm/nova-mes \
  --namespace nova-mes \
  --set image.tag=$TAG \
  --dry-run --debug | grep -A2 DATABASE_URL

# Apply
helm upgrade nova-mes ./helm/nova-mes \
  --namespace nova-mes \
  --set image.tag=$TAG \
  --reuse-values          # keep your existing Dynatrace creds / values overrides
```

Helm applies the new `postgres` Secret + StatefulSet + Services and the updated `mes-web`
Deployment together. The StatefulSet's readiness probe gates it, and `mes-web` retries
its DB connection on startup, so ordering resolves itself within a few seconds.

### Path B — Raw manifests (postgres = ephemeral `emptyDir`)

Apply the **database first**, wait for it to be ready, then roll the rest:

```bash
# 1. Postgres Secret + Deployment + Service, and all other updated resources
kubectl apply -f k8s/

# 2. Wait for postgres to accept connections
kubectl -n nova-mes rollout status deploy/nova-postgres

# 3. Bump the app pods to the new image (if tag didn't change, force a restart)
kubectl -n nova-mes set image deploy/nova-mes-web  web=$IMAGE:$TAG
kubectl -n nova-mes set image deploy/nova-batch-service      batch=$IMAGE:$TAG
kubectl -n nova-mes set image deploy/nova-dispensing-service dispensing=$IMAGE:$TAG
kubectl -n nova-mes set image deploy/nova-loadgen  loadgen=$IMAGE:$TAG
```

> The raw `k8s/nova-mes.yaml` pins `:latest` with `imagePullPolicy: Always`. If you kept
> the `:latest` tag, force a fresh pull instead of `set image`:
> `kubectl -n nova-mes rollout restart deploy/nova-mes-web`

---

## 3. Verify the rollout

```bash
# All pods Running, including the new nova-postgres
kubectl -n nova-mes get pods

# mes-web should log a successful listen and NOT "db init failed"
kubectl -n nova-mes logs deploy/nova-mes-web --tail=30 | grep -iE 'listening|db init'

# Confirm the schema was created and seeded
kubectl -n nova-mes exec deploy/nova-postgres -- \
  psql -U nova_mes -d nova_mes -c '\dt'
kubectl -n nova-mes exec deploy/nova-postgres -- \
  psql -U nova_mes -d nova_mes -c 'SELECT count(*) FROM batch_records;'
```

### Smoke-test the new API through the LoadBalancer

```bash
EXT_IP=$(kubectl -n nova-mes get svc nova-mes-web \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

curl -s http://$EXT_IP/healthz
curl -s http://$EXT_IP/api/dashboard/kpis | head
curl -s http://$EXT_IP/api/batches | head
```

Then open `http://$EXT_IP/` — the sidebar SPA should load with the Dashboard populated.

---

## 4. Rollback

**Helm:**
```bash
helm history nova-mes -n nova-mes
helm rollback nova-mes <PREVIOUS_REVISION> -n nova-mes
```

**Raw manifests:**
```bash
kubectl -n nova-mes rollout undo deploy/nova-mes-web
```

> Rolling `mes-web` back to a pre-DB image is safe — the older code simply ignores the
> `DATABASE_URL` env var and postgres. You can leave the postgres resources running.

---

## Notes & gotchas

- **First deploy of postgres via Helm creates a PVC** that survives `helm uninstall`.
  To fully reset: `kubectl -n nova-mes delete pvc -l app=nova-mes-postgres`.
- **Raw manifests use `emptyDir`** — restarting the postgres pod wipes data and re-seeds
  on the next `mes-web` start. Fine for a demo; use the Helm path if you need durability.
- **Secret rotation:** the DB password lives in `{release}-postgres` (Helm) or
  `nova-mes-postgres` (raw), separate from the OTel secret. Change it in `values.yaml`
  / the manifest and re-apply; then restart both postgres and mes-web.
- **Dynatrace validation:** after traffic flows, a batch-release trace should now include
  child `pg` spans with `db.statement` — confirms the new persistence layer is instrumented.
- **gVisor:** postgres runs on the default runc runtime (not gVisor) with `use-vc`
  DNS-over-TCP and the gVisor node toleration, matching the service pods.
```
