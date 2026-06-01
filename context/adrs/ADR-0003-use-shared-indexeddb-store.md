# ADR-0003: Use Shared IndexedDB Store

Workbench browser persistence must use a shared IndexedDB store helper instead of feature modules opening databases with duplicated versions, upgrade logic, and object-store creation; domain modules may still own record shapes and normalization, but raw IndexedDB open/upgrade/transaction plumbing belongs in the shared helper so markdown editor drafts, agent thread Saved drafts, and future browser-persisted features do not drift into incompatible schema owners.
