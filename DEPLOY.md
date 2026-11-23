# Deploying the clinic site on Render (for the person doing the setup, about 10 minutes)

The site is a small Node.js app (Node 18+, no packages to install). It stores bookings in `data/appointments.json`, so it needs a host with a persistent disk. `render.yaml` already describes the service.

## Steps
1. Create a **private** GitHub repository (e.g. `ghoneem-clinic`) and upload the **contents** of this folder so `server.js` and `render.yaml` are at the top level of the repository (not inside a sub-folder). Do not upload a `.env` file.
2. On render.com sign in with GitHub, then **New → Blueprint**, select the repository.
3. When asked for values:
   - `ADMIN_PASSWORD`: a long, private password (staff use it at `/admin`).
   - `BASE_URL`: `https://<service-name>.onrender.com` for now, then the real domain once connected.
4. Click **Apply**. The plan is Starter (a persistent disk needs a paid web service) with a 1 GB disk mounted at `/opt/render/project/src/data`.
5. When the service shows **Live**, open it and test:
   - Choose a branch and a day, make a test booking.
   - Open `/admin`, sign in, check the booking appears, then cancel it.
   - Service → Manual Deploy → Restart, confirm the booking is still there (proves the disk works).
6. Optional: Service → Settings → Custom Domains, add the clinic's domain and follow the DNS instructions (HTTPS is automatic). Then update `BASE_URL` under Environment.

## If the Blueprint does not work, create the service by hand
New → Web Service → the repository. Runtime Node, Build Command `echo ok`, Start Command `node server.js`, plan Starter. Add a disk (Advanced → Add Disk) with mount path `/opt/render/project/src/data`. Environment variables: `ADMIN_PASSWORD`, `BASE_URL`, `TRUST_PROXY=1`, `NODE_VERSION=22`.

## Notes
- Clinic details (branches, hours, phone, photos, videos) are in `config.json`; photos are in `public/media/`.
- Automatic WhatsApp messages are OFF (`whatsapp.enabled` is `false`). Staff follow up with the prefilled WhatsApp buttons in `/admin`. See `README.md` for turning the WhatsApp API on later.
- Back up the `data/` folder regularly: it holds patient names and phone numbers.
