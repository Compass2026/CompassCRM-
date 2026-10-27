-- PROVISIONAL — NOT APPLIED. Run only after migration 20261027160000 is
-- reviewed, accepted and applied (PR #192), and after core-keyword-lists-v1-proposed.sql.
--
-- BHG Safety Partners: one core keyword list PROPOSAL per site (Tom, Oct 27
-- 2026: "50 per site" — Safety 50, Forklift 50, Heavy Equipment 50). Research:
-- DataForSEO Labs (US, English, latest month, refreshed Sept–Oct 2026) plus
-- live owner pages checked on Oct 27 (every owner page returned 200). Full
-- rationale, rejections and intent changes: Executive OS task 3ab519f3.
--
-- 1. New keyword rows: active, untracked, intent as proposed, research noted
--    in intent_note. Nothing tracked, untracked or deleted; existing rows
--    keep their intent (proposed intent changes are listed for Tom, not applied).
-- 2. One proposed list per site, holding only keywords whose service that
--    site owns (the list rule). Keywords researched onto pages with no CRM
--    service (Heavy Equipment 22: aerial/scissor/boom lift, telehandler,
--    backhoe, bulldozer, dump truck, tractor; Forklift 4: Class 7 rough
--    terrain, train-the-trainer) are inserted but stay out of the lists until
--    Tom decides those services (adding a service to a brand site re-opens
--    its brand approval). Every list also keeps only keywords of that site's
--    services ("safety training" has none). So: Safety 49, Forklift 46,
--    Heavy Equipment 28 — all three stay proposals until they hold 50 valid
--    keywords (8 existing BHG keywords in them also lack an intent).
--
-- Nothing is approved. Re-running is a no-op (existing keywords and lists skipped).

insert into keywords (client_id, keyword, service_id, is_active, is_tracked, priority, intent, intent_note, volume, cpc, city, source, department)
select '3eaa3389-2a33-4004-837c-8aef90404410', v.keyword, v.service_id::uuid, true, false, 'p2', v.intent, v.note, v.volume, v.cpc, v.city, 'dataforseo', 'seo'
from (values
  ('osha 10 general industry', '94c20fa3-60b3-47b5-ab77-df086b079223', 'informational', 390, 7.15, null, 'Proposed BHG core addition (BHG Safety Partners, Oct 27 2026): DataForSEO Labs US 390/mo; owner page https://bhgsafety.com/services/osha-10-general-industry.'),
  ('osha 10 hour construction course', 'bd7f2dd2-46c0-4bf9-9c15-3646234145ed', 'commercial', 1900, 11.94, null, 'Proposed BHG core addition (BHG Safety Partners, Oct 27 2026): DataForSEO Labs US 1900/mo; owner page https://bhgsafety.com/services/osha-10-construction.'),
  ('osha 30 hour training', '4146dfc5-0714-4fa6-8fe3-633be118ca79', 'informational', 3600, 13.76, null, 'Proposed BHG core addition (BHG Safety Partners, Oct 27 2026): DataForSEO Labs US 3600/mo; owner page https://bhgsafety.com/services/osha-30-general-industry.'),
  ('osha 30 general industry', '4146dfc5-0714-4fa6-8fe3-633be118ca79', 'informational', 390, 14.81, null, 'Proposed BHG core addition (BHG Safety Partners, Oct 27 2026): DataForSEO Labs US 390/mo; owner page https://bhgsafety.com/services/osha-30-general-industry.'),
  ('osha 30 hour construction course', '93e2f4fe-44ec-4522-a6d3-1a247690e23c', 'informational', 1900, 12.92, null, 'Proposed BHG core addition (BHG Safety Partners, Oct 27 2026): DataForSEO Labs US 1900/mo; owner page https://bhgsafety.com/services/osha-30-construction.'),
  ('hazwoper 8 hour refresher', '26522279-e115-4b98-9f14-dfccf24e8271', 'transactional', 210, 13.68, null, 'Proposed BHG core addition (BHG Safety Partners, Oct 27 2026): DataForSEO Labs US 210/mo; owner page https://bhgsafety.com/services/hazwoper-training.'),
  ('confined space training', 'dee36610-4375-4137-bbb0-a12c0bbe0826', 'informational', 2900, 10.97, null, 'Proposed BHG core addition (BHG Safety Partners, Oct 27 2026): DataForSEO Labs US 2900/mo; owner page https://bhgsafety.com/services/confined-space-entry-training.'),
  ('first aid training for employees', '4ecc37cc-c2ec-4c95-ba61-64f0e851ff9c', 'informational', 260, 10.98, null, 'Proposed BHG core addition (BHG Safety Partners, Oct 27 2026): DataForSEO Labs US 260/mo; owner page https://bhgsafety.com/services/first-aid-cpr-training.'),
  ('hazcom training', 'bd07b3fd-c6ed-437d-a055-9cd2d3b3370e', 'informational', 1600, 7.62, null, 'Proposed BHG core addition (BHG Safety Partners, Oct 27 2026): DataForSEO Labs US 1600/mo; owner page https://bhgsafety.com/services/hazard-communication-training.'),
  ('industrial hygiene services', '9c31b844-f8e1-4cab-892c-90885c377ba3', 'navigational', 170, 15.27, null, 'Proposed BHG core addition (BHG Safety Partners, Oct 27 2026): DataForSEO Labs US 170/mo; owner page https://bhgsafety.com/services/industrial-hygiene-surveys.'),
  ('ehs consultant', '55125e63-0a52-43c3-b18e-720c861a45f0', 'informational', 880, 25.17, null, 'Proposed BHG core addition (BHG Safety Partners, Oct 27 2026): DataForSEO Labs US 880/mo; owner page https://bhgsafety.com/services/safety-consulting.'),
  ('osha consultant', 'd4ee3ed2-a2f2-4cd6-befc-a6b62547c6e8', 'commercial', 210, 35.11, null, 'Proposed BHG core addition (BHG Safety Partners, Oct 27 2026): DataForSEO Labs US 210/mo; owner page https://bhgsafety.com/services/compliance-audits.'),
  ('safety audit', 'd4ee3ed2-a2f2-4cd6-befc-a6b62547c6e8', 'commercial', 880, 9.16, null, 'Proposed BHG core addition (BHG Safety Partners, Oct 27 2026): DataForSEO Labs US 880/mo; owner page https://bhgsafety.com/services/compliance-audits.'),
  ('construction site safety inspection', 'd2eb8264-d074-4865-a6b9-fa4cd185b3e0', 'informational', 140, 12.94, null, 'Proposed BHG core addition (BHG Safety Partners, Oct 27 2026): DataForSEO Labs US 140/mo; owner page https://bhgsafety.com/services/onsite-safety-inspections.'),
  ('construction safety program', 'f17fe02c-fd99-4533-ba0d-fed72fda411e', 'informational', 210, 37.5, null, 'Proposed BHG core addition (BHG Safety Partners, Oct 27 2026): DataForSEO Labs US 210/mo; owner page https://bhgsafety.com/services/safety-program-development.'),
  ('written safety program', 'f17fe02c-fd99-4533-ba0d-fed72fda411e', 'informational', 170, 15.35, null, 'Proposed BHG core addition (BHG Safety Partners, Oct 27 2026): DataForSEO Labs US 170/mo; owner page https://bhgsafety.com/services/safety-program-development.'),
  ('osha training', '534b4bc2-e9f7-4ba2-b48e-3decc1099acc', 'informational', 12100, 7.99, null, 'Proposed BHG core addition (BHG Safety Partners, Oct 27 2026): DataForSEO Labs US 12100/mo; owner page https://bhgsafety.com/services/workplace-safety-training.'),
  ('workplace safety training', '534b4bc2-e9f7-4ba2-b48e-3decc1099acc', 'informational', 1900, 14.51, null, 'Proposed BHG core addition (BHG Safety Partners, Oct 27 2026): DataForSEO Labs US 1900/mo; owner page https://bhgsafety.com/services/workplace-safety-training.'),
  ('safety training for employees', '534b4bc2-e9f7-4ba2-b48e-3decc1099acc', 'informational', 1900, 17.8, null, 'Proposed BHG core addition (BHG Safety Partners, Oct 27 2026): DataForSEO Labs US 1900/mo; owner page https://bhgsafety.com/services/workplace-safety-training.'),
  ('construction safety training', '534b4bc2-e9f7-4ba2-b48e-3decc1099acc', 'commercial', 1900, 10.64, null, 'Proposed BHG core addition (BHG Safety Partners, Oct 27 2026): DataForSEO Labs US 1900/mo; owner page https://bhgsafety.com/services/workplace-safety-training.'),
  ('forklift certification', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'informational', 49500, 4.02, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 49500/mo; owner page https://www.bhgforklifttraining.com/classes.'),
  ('forklift certification near me', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'commercial', 8100, 2.27, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 8100/mo; owner page https://www.bhgforklifttraining.com/classes.'),
  ('forklift certification training', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'informational', 5400, 4.08, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 5400/mo; owner page https://www.bhgforklifttraining.com/classes.'),
  ('forklift operator training', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'informational', 3600, 4.96, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 3600/mo; owner page https://www.bhgforklifttraining.com/classes.'),
  ('osha forklift certification', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'informational', 3600, 7.8, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 3600/mo; owner page https://www.bhgforklifttraining.com/classes.'),
  ('forklift safety training', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'informational', 2900, 8.32, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 2900/mo; owner page https://www.bhgforklifttraining.com/classes.'),
  ('forklift training program', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'informational', 2400, 5.63, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 2400/mo; owner page https://www.bhgforklifttraining.com/classes.'),
  ('forklift certification class', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'informational', 1900, 4.16, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 1900/mo; owner page https://www.bhgforklifttraining.com/classes.'),
  ('osha forklift training', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'informational', 1300, 8.98, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 1300/mo; owner page https://www.bhgforklifttraining.com/classes.'),
  ('forklift certification cost', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'informational', 1000, 2.73, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 1000/mo; owner page https://www.bhgforklifttraining.com/classes.'),
  ('onsite forklift training', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'commercial', 140, 16.06, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 140/mo; owner page https://www.bhgforklifttraining.com/classes.'),
  ('forklift classes', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'transactional', 1600, 3.39, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 1600/mo; owner page https://www.bhgforklifttraining.com/classes.'),
  ('how to get forklift certification', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'informational', 6600, 2.57, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 6600/mo; owner page https://www.bhgforklifttraining.com/blog/how-to-get-forklift-certified.'),
  ('online forklift certification', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'informational', 2900, 17.36, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 2900/mo; owner page https://www.bhgforklifttraining.com/blog/online-forklift-certification.'),
  ('forklift inspection checklist', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'informational', 1900, 4.57, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 1900/mo; owner page https://www.bhgforklifttraining.com/blog/forklift-inspection-checklist.'),
  ('forklift stability triangle', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'informational', 880, 0.13, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 880/mo; owner page https://www.bhgforklifttraining.com/blog/forklift-stability-triangle.'),
  ('forklift certification renewal', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'informational', 880, 5.66, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 880/mo; owner page https://www.bhgforklifttraining.com/blog/how-long-is-forklift-certification-good-for.'),
  ('how long is forklift certification good for', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'informational', 720, 15.01, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 720/mo; owner page https://www.bhgforklifttraining.com/blog/how-long-is-forklift-certification-good-for.'),
  ('forklift certification requirements osha', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'informational', 590, 8.12, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 590/mo; owner page https://www.bhgforklifttraining.com/classes.'),
  ('forklift pedestrian safety', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'transactional', 260, 7.2, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 260/mo; owner page https://www.bhgforklifttraining.com/blog/forklift-pedestrian-safety.'),
  ('forklift trainer certification', null, 'informational', 480, 19.96, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 480/mo; owner page https://www.bhgforklifttraining.com/blog/forklift-train-the-trainer. No CRM service yet (Forklift Train-the-Trainer (confirm BHG offers it)).'),
  ('forklift train the trainer', null, 'informational', 390, 31.36, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 390/mo; owner page https://www.bhgforklifttraining.com/blog/forklift-train-the-trainer. No CRM service yet (Forklift Train-the-Trainer (confirm BHG offers it)).'),
  ('reach truck training', '689f45ec-098b-45bd-b005-493619bbbd68', 'commercial', 210, 3.4, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 210/mo; owner page https://www.bhgforklifttraining.com/classes/class-2-forklift.'),
  ('reach truck certification', '689f45ec-098b-45bd-b005-493619bbbd68', 'informational', 110, 2.55, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 110/mo; owner page https://www.bhgforklifttraining.com/classes/class-2-forklift.'),
  ('order picker training', '689f45ec-098b-45bd-b005-493619bbbd68', 'informational', 90, 3.61, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 90/mo; owner page https://www.bhgforklifttraining.com/classes/class-2-forklift.'),
  ('order picker certification', '689f45ec-098b-45bd-b005-493619bbbd68', 'informational', 40, 5.79, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 40/mo; owner page https://www.bhgforklifttraining.com/classes/class-2-forklift.'),
  ('pallet jack certification', 'da91e1d3-a12c-4a80-b9ef-ab5cd72e4043', 'informational', 590, 4.4, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 590/mo; owner page https://www.bhgforklifttraining.com/classes/class-3-forklift.'),
  ('electric pallet jack training', 'da91e1d3-a12c-4a80-b9ef-ab5cd72e4043', 'informational', 320, 7.45, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 320/mo; owner page https://www.bhgforklifttraining.com/classes/class-3-forklift.'),
  ('pallet jack training', 'da91e1d3-a12c-4a80-b9ef-ab5cd72e4043', 'transactional', 210, 10.34, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 210/mo; owner page https://www.bhgforklifttraining.com/classes/class-3-forklift.'),
  ('rough terrain forklift certification', null, 'informational', 110, 11.85, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 110/mo; owner page https://www.bhgforklifttraining.com/classes/class-7-forklift. No CRM service yet (Class VII Rough Terrain Forklift Training).'),
  ('rough terrain forklift training', null, 'commercial', 90, 16.69, null, 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 90/mo; owner page https://www.bhgforklifttraining.com/classes/class-7-forklift. No CRM service yet (Class VII Rough Terrain Forklift Training).'),
  ('forklift certification el paso', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'navigational', 210, 4.09, 'El Paso', 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 210/mo; owner page https://www.bhgforklifttraining.com/classes.'),
  ('forklift certification atlanta', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'informational', 170, 4.24, 'Atlanta', 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 170/mo; owner page https://www.bhgforklifttraining.com/classes.'),
  ('forklift certification san antonio', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'informational', 140, 5.23, 'San Antonio', 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 140/mo; owner page https://www.bhgforklifttraining.com/classes.'),
  ('forklift certification oklahoma city', '4673f4d0-352a-4479-8997-4978fb64fa7f', 'informational', 50, 7.08, 'Oklahoma City', 'Proposed BHG core addition (BHG Forklift Training, Oct 27 2026): DataForSEO Labs US 50/mo; owner page https://www.bhgforklifttraining.com/classes.'),
  ('heavy equipment training', 'b67119e0-205a-434d-8b5d-20a7c7cf8bb6', 'commercial', 1900, 4.2, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 1900/mo; owner page https://www.bhgheavyequipment.com/services.'),
  ('heavy equipment operator training near me', 'b67119e0-205a-434d-8b5d-20a7c7cf8bb6', 'commercial', 1900, 3.65, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 1900/mo; owner page https://www.bhgheavyequipment.com/services.'),
  ('heavy equipment operator certification', 'b67119e0-205a-434d-8b5d-20a7c7cf8bb6', 'informational', 1300, 4.04, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 1300/mo; owner page https://www.bhgheavyequipment.com/services.'),
  ('heavy equipment training program', 'b67119e0-205a-434d-8b5d-20a7c7cf8bb6', 'informational', 880, 2.55, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 880/mo; owner page https://www.bhgheavyequipment.com/services.'),
  ('heavy equipment certification', 'b67119e0-205a-434d-8b5d-20a7c7cf8bb6', 'informational', 590, 3.76, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 590/mo; owner page https://www.bhgheavyequipment.com/services.'),
  ('heavy equipment training near me', 'b67119e0-205a-434d-8b5d-20a7c7cf8bb6', 'commercial', 590, 3.43, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 590/mo; owner page https://www.bhgheavyequipment.com/services.'),
  ('heavy equipment safety training', 'b67119e0-205a-434d-8b5d-20a7c7cf8bb6', 'informational', 260, 3.25, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 260/mo; owner page https://www.bhgheavyequipment.com/services.'),
  ('excavator training', 'f08e0d26-1e41-4e24-9a7a-330e374920a0', 'commercial', 720, 4.69, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 720/mo; owner page https://www.bhgheavyequipment.com/services/excavator-training.'),
  ('excavator operator training', 'f08e0d26-1e41-4e24-9a7a-330e374920a0', 'informational', 480, 4.04, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 480/mo; owner page https://www.bhgheavyequipment.com/services/excavator-training.'),
  ('excavator certification', 'f08e0d26-1e41-4e24-9a7a-330e374920a0', 'informational', 320, 5.15, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 320/mo; owner page https://www.bhgheavyequipment.com/services/excavator-training.'),
  ('excavator training near me', 'f08e0d26-1e41-4e24-9a7a-330e374920a0', 'commercial', 320, 3.43, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 320/mo; owner page https://www.bhgheavyequipment.com/services/excavator-training.'),
  ('excavator operator certification', 'f08e0d26-1e41-4e24-9a7a-330e374920a0', 'informational', 140, 7.57, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 140/mo; owner page https://www.bhgheavyequipment.com/services/excavator-training.'),
  ('mini excavator training', 'f08e0d26-1e41-4e24-9a7a-330e374920a0', 'transactional', 140, 6.06, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 140/mo; owner page https://www.bhgheavyequipment.com/services/excavator-training.'),
  ('excavator safety training', 'f08e0d26-1e41-4e24-9a7a-330e374920a0', 'informational', 90, 13.59, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 90/mo; owner page https://www.bhgheavyequipment.com/services/excavator-training.'),
  ('skid steer training', 'e91e71bd-bc06-4558-ab38-1a8e7bae6c9d', 'informational', 720, 9.01, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 720/mo; owner page https://www.bhgheavyequipment.com/services/skid-steer-training.'),
  ('skid loader training', 'e91e71bd-bc06-4558-ab38-1a8e7bae6c9d', 'commercial', 720, 9.01, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 720/mo; owner page https://www.bhgheavyequipment.com/services/skid-steer-training.'),
  ('skid steer certification', 'e91e71bd-bc06-4558-ab38-1a8e7bae6c9d', 'informational', 390, 9.33, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 390/mo; owner page https://www.bhgheavyequipment.com/services/skid-steer-training.'),
  ('skid steer operator training', 'e91e71bd-bc06-4558-ab38-1a8e7bae6c9d', 'informational', 320, 6.53, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 320/mo; owner page https://www.bhgheavyequipment.com/services/skid-steer-training.'),
  ('skid steer training near me', 'e91e71bd-bc06-4558-ab38-1a8e7bae6c9d', 'commercial', 140, 3.09, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 140/mo; owner page https://www.bhgheavyequipment.com/services/skid-steer-training.'),
  ('skid steer safety training', 'e91e71bd-bc06-4558-ab38-1a8e7bae6c9d', 'informational', 90, 19.37, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 90/mo; owner page https://www.bhgheavyequipment.com/services/skid-steer-training.'),
  ('skid steer operator certification', 'e91e71bd-bc06-4558-ab38-1a8e7bae6c9d', 'informational', 90, 6.75, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 90/mo; owner page https://www.bhgheavyequipment.com/services/skid-steer-training.'),
  ('front end loader training', '4e4ebc27-95a5-4c32-9584-1ecc5b119805', 'informational', 140, 5.02, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 140/mo; owner page https://www.bhgheavyequipment.com/services/front-end-loader-training.'),
  ('loader operator training', '4e4ebc27-95a5-4c32-9584-1ecc5b119805', 'informational', 70, 2.32, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 70/mo; owner page https://www.bhgheavyequipment.com/services/front-end-loader-training.'),
  ('front end loader certification', '4e4ebc27-95a5-4c32-9584-1ecc5b119805', 'informational', 50, 8.3, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 50/mo; owner page https://www.bhgheavyequipment.com/services/front-end-loader-training.'),
  ('scissor lift certification', null, 'informational', 1300, 14.25, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 1300/mo; owner page https://www.bhgheavyequipment.com/services/scissor-lift-training. No CRM service yet (Scissor Lift Training).'),
  ('mewp training', null, 'informational', 1300, 13.9, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 1300/mo; owner page https://www.bhgheavyequipment.com/services/aerial-lift-training. No CRM service yet (Aerial Lift (MEWP) Training).'),
  ('aerial lift certification', null, 'informational', 880, 16.17, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 880/mo; owner page https://www.bhgheavyequipment.com/services/aerial-lift-training. No CRM service yet (Aerial Lift (MEWP) Training).'),
  ('scissor lift training', null, 'informational', 880, 21.31, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 880/mo; owner page https://www.bhgheavyequipment.com/services/scissor-lift-training. No CRM service yet (Scissor Lift Training).'),
  ('boom lift certification', null, 'informational', 720, 12.17, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 720/mo; owner page https://www.bhgheavyequipment.com/services/boom-lift-training. No CRM service yet (Boom Lift Training).'),
  ('mewp certification', null, 'informational', 720, 9.89, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 720/mo; owner page https://www.bhgheavyequipment.com/services/aerial-lift-training. No CRM service yet (Aerial Lift (MEWP) Training).'),
  ('aerial lift training', null, 'informational', 480, 22.64, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 480/mo; owner page https://www.bhgheavyequipment.com/services/aerial-lift-training. No CRM service yet (Aerial Lift (MEWP) Training).'),
  ('boom lift training', null, 'transactional', 390, 11.14, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 390/mo; owner page https://www.bhgheavyequipment.com/services/boom-lift-training. No CRM service yet (Boom Lift Training).'),
  ('osha scissor lift training', null, 'informational', 260, 16.69, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 260/mo; owner page https://www.bhgheavyequipment.com/services/scissor-lift-training. No CRM service yet (Scissor Lift Training).'),
  ('osha aerial lift training', null, 'informational', 170, 15.1, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 170/mo; owner page https://www.bhgheavyequipment.com/services/aerial-lift-training. No CRM service yet (Aerial Lift (MEWP) Training).'),
  ('scissor lift safety training', null, 'informational', 170, 10.44, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 170/mo; owner page https://www.bhgheavyequipment.com/services/scissor-lift-training. No CRM service yet (Scissor Lift Training).'),
  ('man lift certification', null, 'informational', 140, 15.92, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 140/mo; owner page https://www.bhgheavyequipment.com/services/aerial-lift-training. No CRM service yet (Aerial Lift (MEWP) Training).'),
  ('telehandler certification', null, 'informational', 480, 13.64, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 480/mo; owner page https://www.bhgheavyequipment.com/services/telehandler-training. No CRM service yet (Telehandler Training).'),
  ('telehandler training', null, 'informational', 260, 16.59, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 260/mo; owner page https://www.bhgheavyequipment.com/services/telehandler-training. No CRM service yet (Telehandler Training).'),
  ('telehandler operator training', null, 'informational', 50, 7.41, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 50/mo; owner page https://www.bhgheavyequipment.com/services/telehandler-training. No CRM service yet (Telehandler Training).'),
  ('backhoe training', null, 'commercial', 170, 2.81, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 170/mo; owner page https://www.bhgheavyequipment.com/services/backhoe-training. No CRM service yet (Backhoe Training).'),
  ('backhoe operator training', null, 'commercial', 170, 3.19, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 170/mo; owner page https://www.bhgheavyequipment.com/services/backhoe-training. No CRM service yet (Backhoe Training).'),
  ('backhoe certification', null, 'informational', 90, 5.68, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 90/mo; owner page https://www.bhgheavyequipment.com/services/backhoe-training. No CRM service yet (Backhoe Training).'),
  ('bulldozer operator training', null, 'informational', 110, 1.82, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 110/mo; owner page https://www.bhgheavyequipment.com/services/bulldozer-training. No CRM service yet (Bulldozer Training).'),
  ('bulldozer training', null, 'transactional', 90, 3.09, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 90/mo; owner page https://www.bhgheavyequipment.com/services/bulldozer-training. No CRM service yet (Bulldozer Training).'),
  ('dump truck training', null, 'commercial', 320, 6.28, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 320/mo; owner page https://www.bhgheavyequipment.com/services/dump-truck-training. No CRM service yet (Dump Truck Training).'),
  ('tractor safety training', null, 'informational', 70, 4.8, null, 'Proposed BHG core addition (BHG Heavy Equipment Training, Oct 27 2026): DataForSEO Labs US 70/mo; owner page https://www.bhgheavyequipment.com/services/tractor-training. No CRM service yet (Tractor Safety Training).')
) v(keyword, service_id, intent, volume, cpc, city, note)
where not exists (select 1 from keywords k where k.client_id = '3eaa3389-2a33-4004-837c-8aef90404410' and lower(k.keyword) = lower(v.keyword));

-- BHG Safety Partners: 50 researched, 49 in the list ("safety training" has
-- no CRM service; mapping it to Workplace Safety Training is Tom's call)
insert into core_keyword_lists (client_id, brand_workspace_id, keyword_ids, source_ref)
select '3eaa3389-2a33-4004-837c-8aef90404410', '127b7514-a914-4c73-b4c1-2309c2550cd6', array_agg(distinct k.id),
  'BHG per-site core 50 research (Oct 27 2026; DataForSEO Labs + live owner pages); 49 of 50 mapped to services of this site. Proposed for approval: executive_os:task/3ab519f3-27bd-416c-a3f1-219b285462c3'
from (values
  ('9b86008d-4511-42ff-8e15-70046ba3cc15', 'osha 10'),
  ('335f84e9-69b5-4516-911e-da789cf97ea9', 'osha 10 certification'),
  ('651520d0-1a32-4e8a-9723-a3cdb4688355', 'osha 10 hour training'),
  ('ed03fb8f-6044-4aea-9ac2-5278adeb92b5', 'osha 10 hour outreach training program'),
  (null, 'osha 10 general industry'),
  ('505bd547-ca66-4d95-8298-017ad9fed929', 'osha 10 hour training construction'),
  (null, 'osha 10 hour construction course'),
  ('42edc6e4-34c9-4fb2-a1ab-25442a39a388', 'osha 30 certification'),
  ('d6e27ac3-af3c-4960-8228-494d137ec00f', 'osha 30 training'),
  (null, 'osha 30 hour training'),
  (null, 'osha 30 general industry'),
  ('dcc24c60-1be7-45ec-8a99-7fc373335f8d', 'osha 30 hour training construction'),
  (null, 'osha 30 hour construction course'),
  ('d64bcbc6-1971-4464-bc5b-710e2e12bf54', 'hazwoper training'),
  ('808fae13-11ad-4a2b-8521-4b8a1f969885', 'hazwoper 40 hour training'),
  ('e91b363c-4c31-4b3e-9dd2-13a4cd90e4aa', 'hazwoper 24 hour training'),
  (null, 'hazwoper 8 hour refresher'),
  (null, 'confined space training'),
  ('595e2e14-d157-4e79-a2c7-2c632577cb9f', 'confined space training course'),
  ('6a678b89-422a-40ed-aa6d-e3126c3c52b1', 'confined space entry training'),
  ('b4f659fa-28df-420a-938c-f8beac9310ba', 'first aid certification'),
  ('a9900416-2de1-4820-b73e-a8fffb5bfac2', 'first aid training'),
  ('15a31b9e-32aa-45c8-abf9-18b17e5c5879', 'first aid cpr training'),
  (null, 'first aid training for employees'),
  ('ceef9f18-866e-4232-8040-71a95f8fe6bf', 'hazard communication training'),
  (null, 'hazcom training'),
  ('15bf00cf-9197-4d52-adbd-2ea690fb97ed', 'osha hazard communication training'),
  ('48de25dc-612b-4467-ae3d-e252cdcf702a', 'industrial hygiene consultant'),
  ('6a7d151d-31d3-4f1b-8e7f-6ce2ac67207d', 'industrial hygiene testing'),
  (null, 'industrial hygiene services'),
  ('06ae9115-7f50-4d79-87b8-aba5ef5357bc', 'industrial hygiene survey'),
  ('e250fe84-9f37-48c6-871a-bf65a3f03b5c', 'safety consultant'),
  ('022ff3a4-207d-45f4-8b0a-4fd4d76c5a9f', 'safety consulting services'),
  ('45fd7cd4-6100-4986-9f29-4cb318ff48a6', 'environmental health & safety consultant'),
  (null, 'ehs consultant'),
  ('cf828244-7f7c-4e77-8a63-451566f999be', 'safety consultant near me'),
  ('3eeead85-ffd9-4ef2-922b-91f3594ea5aa', 'construction safety consultant'),
  ('865c79ea-fcb7-40b5-bcf3-5fad4e030d2d', 'osha compliance consultant'),
  (null, 'osha consultant'),
  (null, 'safety audit'),
  (null, 'construction site safety inspection'),
  (null, 'construction safety program'),
  (null, 'written safety program'),
  ('9c3ca0e7-caf0-4047-bb3f-b6d4f26c7418', 'virtual safety manager'),
  (null, 'osha training'),
  ('c855874d-39bc-4891-a6b4-e73a55aed6d2', 'safety training'),
  (null, 'workplace safety training'),
  (null, 'safety training for employees'),
  (null, 'construction safety training'),
  ('af6b2aee-17ab-446e-9e53-166839bc2c3b', 'workplace safety training programs')
) v(existing_id, keyword)
join keywords k on k.client_id = '3eaa3389-2a33-4004-837c-8aef90404410' and k.is_active
  and (k.id = v.existing_id::uuid or (v.existing_id is null and lower(k.keyword) = lower(v.keyword)))
  and k.service_id = any((select w.service_ids from client_brand_workspaces w where w.id = '127b7514-a914-4c73-b4c1-2309c2550cd6'))
where not exists (select 1 from core_keyword_lists l where l.client_id = '3eaa3389-2a33-4004-837c-8aef90404410' and l.brand_workspace_id = '127b7514-a914-4c73-b4c1-2309c2550cd6')
having count(*) > 0;

-- BHG Forklift Training: 46 keywords (15 existing, 31 new)
insert into core_keyword_lists (client_id, brand_workspace_id, keyword_ids, source_ref)
select '3eaa3389-2a33-4004-837c-8aef90404410', 'd8598959-62d5-47f5-900c-ba73c1b840e5', array_agg(distinct k.id),
  'BHG per-site core 50 research (Oct 27 2026; DataForSEO Labs + live owner pages); 46 of 50 mapped to services of this site. Proposed for approval: executive_os:task/3ab519f3-27bd-416c-a3f1-219b285462c3'
from (values
  (null, 'forklift certification'),
  ('d647f4bc-4166-4cd4-a10f-b84edd79b2eb', 'forklift training'),
  (null, 'forklift certification near me'),
  ('8373bbdf-a0ad-4d0f-b3fa-125c1b0b6796', 'osha compliant forklift training program'),
  ('56cb21e3-bee7-47a7-9c4a-74aecc933691', 'osha compliant forklift training'),
  ('1aee62d6-f2eb-40f6-94df-fcaf3891fa65', 'forklift training near me'),
  (null, 'forklift certification training'),
  ('c6af9364-0dd6-4463-8fa8-7768c3be0bc1', 'forklift training course'),
  (null, 'forklift operator training'),
  (null, 'osha forklift certification'),
  (null, 'forklift safety training'),
  (null, 'forklift training program'),
  ('5a3f8f76-856a-4c11-99df-38ee96f6bc38', 'forklift certification course'),
  (null, 'forklift certification class'),
  ('5eaf5010-6024-4ac0-a78e-9c18601ab131', 'forklift operator certification'),
  (null, 'osha forklift training'),
  (null, 'forklift certification cost'),
  (null, 'onsite forklift training'),
  (null, 'forklift classes'),
  (null, 'how to get forklift certification'),
  (null, 'online forklift certification'),
  (null, 'forklift inspection checklist'),
  (null, 'forklift stability triangle'),
  (null, 'forklift certification renewal'),
  (null, 'how long is forklift certification good for'),
  (null, 'forklift certification requirements osha'),
  (null, 'forklift pedestrian safety'),
  ('866a1545-7487-4ee9-839a-6fbd11ca89af', 'class 1 electric rider forklift training'),
  ('01ec0050-7165-45da-9b88-e2b68cedf5c6', 'class 2 narrow aisle forklift training'),
  (null, 'reach truck training'),
  (null, 'reach truck certification'),
  (null, 'order picker training'),
  (null, 'order picker certification'),
  ('be9a27bf-0398-47f9-a983-59698f3107a4', 'class 3 electric pallet jack training'),
  (null, 'pallet jack certification'),
  (null, 'electric pallet jack training'),
  (null, 'pallet jack training'),
  ('0582fb84-6f64-4efd-aa02-b0d7c452b965', 'forklift certification houston'),
  ('38e27f07-21a2-46fd-9ebe-838d9dc386d4', 'forklift certification chicago'),
  (null, 'forklift certification el paso'),
  (null, 'forklift certification atlanta'),
  (null, 'forklift certification san antonio'),
  ('04ddc85c-b09e-446d-a8c9-239bc6efa1b5', 'forklift certification st. louis'),
  ('6336d235-ea8a-449a-9b15-1e61aaa2df0f', 'forklift certification dallas'),
  (null, 'forklift certification oklahoma city'),
  ('756a2c89-90f5-4a62-a2bd-3cba91590e11', 'forklift certification indianapolis')
) v(existing_id, keyword)
join keywords k on k.client_id = '3eaa3389-2a33-4004-837c-8aef90404410' and k.is_active
  and (k.id = v.existing_id::uuid or (v.existing_id is null and lower(k.keyword) = lower(v.keyword)))
  and k.service_id = any((select w.service_ids from client_brand_workspaces w where w.id = 'd8598959-62d5-47f5-900c-ba73c1b840e5'))
where not exists (select 1 from core_keyword_lists l where l.client_id = '3eaa3389-2a33-4004-837c-8aef90404410' and l.brand_workspace_id = 'd8598959-62d5-47f5-900c-ba73c1b840e5')
having count(*) > 0;

-- BHG Heavy Equipment Training: 28 keywords (4 existing, 24 new)
insert into core_keyword_lists (client_id, brand_workspace_id, keyword_ids, source_ref)
select '3eaa3389-2a33-4004-837c-8aef90404410', '9058fbd1-9177-4436-a879-1ffcb28fc26b', array_agg(distinct k.id),
  'BHG per-site core 50 research (Oct 27 2026; DataForSEO Labs + live owner pages); 28 of 50 mapped to services of this site. Proposed for approval: executive_os:task/3ab519f3-27bd-416c-a3f1-219b285462c3'
from (values
  ('d44a559c-af2c-4672-81ea-7dd888442afa', 'heavy equipment operator training'),
  (null, 'heavy equipment training'),
  (null, 'heavy equipment operator training near me'),
  (null, 'heavy equipment operator certification'),
  (null, 'heavy equipment training program'),
  (null, 'heavy equipment certification'),
  (null, 'heavy equipment training near me'),
  (null, 'heavy equipment safety training'),
  ('d9b8ed0c-40b1-476e-93a9-2355ef59bdbe', 'excavator operator training course'),
  (null, 'excavator training'),
  (null, 'excavator operator training'),
  (null, 'excavator certification'),
  (null, 'excavator training near me'),
  (null, 'excavator operator certification'),
  (null, 'mini excavator training'),
  (null, 'excavator safety training'),
  ('ebdeb6dc-4ea8-41ce-a8a6-19fd5baa98e2', 'skid steer operator training course'),
  (null, 'skid steer training'),
  (null, 'skid loader training'),
  (null, 'skid steer certification'),
  (null, 'skid steer operator training'),
  (null, 'skid steer training near me'),
  (null, 'skid steer safety training'),
  (null, 'skid steer operator certification'),
  ('c94b3901-4044-4abf-85da-7c4dda51e6fe', 'front end loader operator training'),
  (null, 'front end loader training'),
  (null, 'loader operator training'),
  (null, 'front end loader certification')
) v(existing_id, keyword)
join keywords k on k.client_id = '3eaa3389-2a33-4004-837c-8aef90404410' and k.is_active
  and (k.id = v.existing_id::uuid or (v.existing_id is null and lower(k.keyword) = lower(v.keyword)))
  and k.service_id = any((select w.service_ids from client_brand_workspaces w where w.id = '9058fbd1-9177-4436-a879-1ffcb28fc26b'))
where not exists (select 1 from core_keyword_lists l where l.client_id = '3eaa3389-2a33-4004-837c-8aef90404410' and l.brand_workspace_id = '9058fbd1-9177-4436-a879-1ffcb28fc26b')
having count(*) > 0;
