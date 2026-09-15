# Golden V1 receipt chain

Generated once using the unmodified V1 ReceiptStore at commit
`f4de84a75f1da71216618772a154c94469619591` on 2026-09-14.
The fixture contains synthetic empty evidence and two events: available and
review-failed. It has never contained Chrome evidence. Do not regenerate it
using the V2 writer. Tests copy it into temporary storage, restore the original
0444 file / 0555 receipt-directory modes that Git cannot retain, and create the
empty .pending directory that Git cannot retain before verification.

The original canonical tail is
`c2a28877cf698c504739dd2f3089c14b0f128c66bc8dcbc1791e292fa650aeb5`.
These SHA-256 values cover every stored file, including the custody witness and
convenience pointer. Tests pin these bytes before and after appending V2 events.

```text
7e72f84b41e9ba44d10c8654c83763e71c13eb41492ad3d1bab6cc27cc8fc4ca  review-receipts/.custody-head
74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b  review-receipts/2026-09-14T00-00-00.000Z_v1-golden/attestation.json
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a  review-receipts/2026-09-14T00-00-00.000Z_v1-golden/os/after/evidence.json
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a  review-receipts/2026-09-14T00-00-00.000Z_v1-golden/os/before/evidence.json
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a  review-receipts/2026-09-14T00-00-00.000Z_v1-golden/os/verification/evidence.json
2c800a3dbb7520e37129213f0dabb648bca6cde03ed3180c91faee1f868f0821  review-receipts/2026-09-14T00-00-00.000Z_v1-golden/policy-snapshot.json
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a  review-receipts/2026-09-14T00-00-00.000Z_v1-golden/project/active-version.json
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a  review-receipts/2026-09-14T00-00-00.000Z_v1-golden/project/candidate-version.json
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a  review-receipts/2026-09-14T00-00-00.000Z_v1-golden/project/dependency-lock.json
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a  review-receipts/2026-09-14T00-00-00.000Z_v1-golden/project/source-hashes.json
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a  review-receipts/2026-09-14T00-00-00.000Z_v1-golden/project/test-results.json
c158d856e405cd06d9aa4aebfdc843d3477337aaafb75e7b3f71425cbfde10cb  review-receipts/2026-09-14T00-00-00.000Z_v1-golden/receipt.json
a2e659fd52b5e72d3984ad280b225d60fbbedd461e0ec074f3472eeec03b4b28  review-receipts/2026-09-14T00-00-00.000Z_v1-golden/receipt.sha256
ca4ac8b9e07257884de9b9dedb7467c5ef76308a627837340b2ae3fcb147e88a  review-receipts/2026-09-14T00-00-00.000Z_v1-golden/report.md
74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b  review-receipts/2026-09-14T00-00-00.001Z_v1-golden/attestation.json
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a  review-receipts/2026-09-14T00-00-00.001Z_v1-golden/os/after/evidence.json
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a  review-receipts/2026-09-14T00-00-00.001Z_v1-golden/os/before/evidence.json
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a  review-receipts/2026-09-14T00-00-00.001Z_v1-golden/os/verification/evidence.json
2c800a3dbb7520e37129213f0dabb648bca6cde03ed3180c91faee1f868f0821  review-receipts/2026-09-14T00-00-00.001Z_v1-golden/policy-snapshot.json
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a  review-receipts/2026-09-14T00-00-00.001Z_v1-golden/project/active-version.json
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a  review-receipts/2026-09-14T00-00-00.001Z_v1-golden/project/candidate-version.json
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a  review-receipts/2026-09-14T00-00-00.001Z_v1-golden/project/dependency-lock.json
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a  review-receipts/2026-09-14T00-00-00.001Z_v1-golden/project/source-hashes.json
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a  review-receipts/2026-09-14T00-00-00.001Z_v1-golden/project/test-results.json
c2a28877cf698c504739dd2f3089c14b0f128c66bc8dcbc1791e292fa650aeb5  review-receipts/2026-09-14T00-00-00.001Z_v1-golden/receipt.json
5a1b3dc84f13ac707580847df93bae02fc1aa1f5298c1e87942eced102a7763a  review-receipts/2026-09-14T00-00-00.001Z_v1-golden/receipt.sha256
04fad6b449955ffc3d55abda44d2fad60f2d0a2abd3e2bbe0b54f45c60d9fc5d  review-receipts/2026-09-14T00-00-00.001Z_v1-golden/report.md
e7d9f028126876008a7819e30d26d157d02501b57d7d2aa9f6931f45a55d6e29  review-receipts/latest-failure.json
```
