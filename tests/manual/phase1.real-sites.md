# Phase 1 real-site integration checklist

Run these checks manually with supervision. They are intentionally not part of the automated suite.

- [ ] Rename or remove `.browser-profile/`, run the tool, manually log into ChatGPT and Claude, press ENTER, and confirm both final results are `ready`.
- [ ] Run it again with the same dedicated profile; confirm both sites are `ready` without the login prompt.
- [ ] Temporarily break one configured URL; confirm the other real site still loads and is logged independently.
- [ ] Press Ctrl+C during launch; confirm the next run can reuse the profile without an orphaned browser or profile lock.
- [ ] Confirm the resolved profile path is the dedicated automation profile and not the daily Chrome profile.
