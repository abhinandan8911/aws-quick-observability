# Captured dashboards

Each file here is one Amazon Quick dashboard, exported exactly as the API returns it and
deployed verbatim by `lib/dashboards.ts`. This is how the freeform layout, the NITRO theme,
the calculated fields, the conditional formatting and the sparklines survive — none of that
round-trips through a hand-written builder.

| File | Dashboard | Datasets it binds |
|---|---|---|
| `pulse.json` | Quick Pulse: Admin Observability | chat activity, API audit |
| `operations.json` | Quick Observability Dashboard | agent hours, index storage, KB sync |

## Updating a dashboard

Edit it in Quick, then re-export and replace the file. Do not hand-patch the JSON.

```bash
aws quicksight describe-dashboard-definition \
  --aws-account-id <account> --dashboard-id <id> --region <region> \
  --query '{Name:Name, ThemeArn:ThemeArn, DashboardPublishOptions:DashboardPublishOptions, Definition:Definition}' \
  > operations.json
```

Then neutralise the account: replace every `DataSetArn` under
`Definition.DataSetIdentifierDeclarations` with the string `RESOLVED_AT_SYNTH`. Leave each
`Identifier` alone — the visuals reference it, and `resolveDashboard` rebinds only the ARN,
matching the identifier's dataset suffix to whatever this deployment created. That is why the
files carry no account id and survive a different `QUICK_OBS_PREFIX`.

## Adding or removing a dashboard

Add or drop an entry in `CAPTURED_DASHBOARDS` (`lib/dashboards.ts`) and give it a dashboard
id in `NAMES` (`lib/config.ts`). A dashboard that references a dataset the current
configuration does not build fails loudly at synth rather than deploying a broken version.
