# Microsoft Graph setup — info@apricoti.co.uk only

Outreach sends **only** as `info@apricoti.co.uk`, through Microsoft Graph. This sets up two locks:

1. **Tenant lock**: an app registration that Exchange Online allows to touch **only** the info@ mailbox.
2. **Code lock**: `ALLOWED_SENDER = 'info@apricoti.co.uk'` in `supabase/functions/_shared/graph/graphMail.ts`. It is a constant, every send checks it, and there is no fallback sender.

You need Global Admin (or Application Admin + Exchange Admin) in the Microsoft 365 tenant that hosts info@apricoti.co.uk.

## 1. Register the app (Entra admin centre)
1. https://entra.microsoft.com → **Applications → App registrations → New registration**.
   - Name: `Apricoti Outreach (info@ only)`. Supported account types: **this organisational directory only**. No redirect URI.
2. Copy the **Application (client) ID** and **Directory (tenant) ID**.
3. **Certificates & secrets → New client secret** (24 months). Copy the **value** now, because it's only shown once.
4. **API permissions → Add → Microsoft Graph → Application permissions**:
   - `Mail.Send`
   - `Mail.ReadWrite` (needed to create drafts so we can track message ids, read replies and bounces, and flag replies)
   - Do **not** add `User.Read.All` or anything else.
5. **Grant admin consent**.

At this point the app could reach *every* mailbox. Step 2 removes that.

## 2. Restrict it to info@apricoti.co.uk (Exchange Online PowerShell)
```powershell
Install-Module ExchangeOnlineManagement -Scope CurrentUser
```
```powershell
Connect-ExchangeOnline
```
```powershell
New-DistributionGroup -Name "Apricoti Graph Outreach Scope" -Alias apricoti-graph-scope -Type Security -Members info@apricoti.co.uk
```
```powershell
New-ApplicationAccessPolicy -AppId <CLIENT_ID> -PolicyScopeGroupId apricoti-graph-scope@apricoti.co.uk -AccessRight RestrictAccess -Description "Apricoti outreach: info@ only"
```
Prove the restriction. The first command must say **Granted** and the second **Denied**. Use any other real mailbox in the tenant for the second:
```powershell
Test-ApplicationAccessPolicy -Identity info@apricoti.co.uk -AppId <CLIENT_ID>
```
```powershell
Test-ApplicationAccessPolicy -Identity <another-mailbox>@apricoti.co.uk -AppId <CLIENT_ID>
```
The policy can take up to an hour to apply. Keep only info@ in that group.

> Microsoft also offers "RBAC for Applications" (`New-ManagementScope` + `New-ManagementRoleAssignment -Role "Application Mail.Send"`) as the newer way to do the same scoping. Either works. If you use it, remove the Entra-level Mail permissions from step 1.4, as Microsoft's docs describe.

## 3. Store the secrets (never in git)
**Supabase** (for the edge functions):
```powershell
supabase secrets set MS_GRAPH_TENANT_ID=<tenant> MS_GRAPH_CLIENT_ID=<client> MS_GRAPH_CLIENT_SECRET=<secret> MS_GRAPH_MAILBOX=info@apricoti.co.uk
```
**Local** (for `npm run graph:selftest`): copy `.env.automation.example` to `.env.automation` and fill it in.

## 4. Prove it (sends nothing)
```powershell
npm run graph:selftest
```
Expected: every non-info@ address is **refused**, and the credentials **can open the info@apricoti.co.uk mailbox**.
If `MS_GRAPH_MAILBOX` is anything else, or the secret is wrong, it fails, and so does outreach (`graph_unavailable`, no sends).

## 5. Inbound check (known issue §10.4)
STATUS.md notes that a Dropbox email to info@ never arrived. Before going live, send a test email **to** info@apricoti.co.uk from an outside address and confirm it lands in the Inbox. Reply and bounce detection depends on it.
