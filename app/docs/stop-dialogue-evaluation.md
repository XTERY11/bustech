# Conversational stop and intent evaluation

Run: 2026-10-02. Real DeepSeek provider, synthetic journeys. No bookings were submitted.

31/31 assertions passed after correcting a companion-needs interpretation failure in the initial 27-case run (26/27). This is a bounded regression set, not a population accuracy estimate. Groq audio/noise accuracy is outside this text evaluation.

The station names and codes used by UI fixtures are synthetic test records; these tests do not establish their real LTA codes.

| Case | Input | Result |
|---|---|---|
| abbreviation | bef the synergy | PASS |
| speech_homophone | B4 the Synergy | PASS |
| expanded_name | before the synergy | PASS |
| typo | bef the synergi | PASS |
| code | 11111 | PASS |
| unknown_code | 99999 | PASS |
| unknown_place | Atlantis Space Terminal | PASS |
| chinese_place | 我在 Bef the Synergy 上车 | PASS |
| here | I am here, use the nearest stop | PASS |
| wheelchair | I use a wheelchair and need more time to board. | PASS |
| time_only | I just need more time to board. | PASS |
| vision | I cannot see well. Help me identify my bus. | PASS |
| hearing | I am deaf. Please show me written boarding guidance. | PASS |
| companion | My companion is blind. I use a wheelchair. | PASS |
| companion_paraphrase | I need a ramp, and my friend needs audio because she cannot see. | PASS |
| helper_not_passenger | My friend will help me board. I need more time. | PASS |
| negative_ramp | I do not need a ramp. I only need more time. | PASS |
| opposite_correction | Not before the Synergy, opposite the Synergy. | PASS |
| multiple_passengers | Book a ramp for me and a separate request for my friend. | PASS |
| unknown_bus | Actually I need bus 999. | PASS |
| new_stop | Actually I will board opposite the Synergy. | PASS |
| chinese_help | 我坐轮椅，需要坡道和更多上车时间。 | PASS |
| followup_0 | {'kind': 'text', 'text': 'bef the synergy'} | PASS |
| followup_1 | {'kind': 'stops'} | PASS |
| followup_2 | {'kind': 'text', 'text': 'yes'} | PASS |
| followup_3 | {'kind': 'text', 'text': '191. I use a wheelchair and need more time.'} | PASS |
| followup_4 | {'kind': 'text', 'text': 'yes'} | PASS |
| followup_5 | {'kind': 'text', 'text': 'No ramp, but keep the extra time.'} | PASS |
| followup_6 | {'kind': 'text', 'text': 'I also have difficulty seeing. Help me identify my bus.'} | PASS |
| followup_7 | {'kind': 'text', 'text': "Don't send my request yet."} | PASS |
| followup_8 | {'kind': 'text', 'text': 'send my request'} | PASS |

Independent validation: Swift station-retrieval tests cover Bef/B4/Before, Aft/After, Opp/Opposite, spelling edits, road-qualified searches, ambiguous names, exact numeric codes and no matches. Gateway tests cover search completion and prevent an ambiguous yes from selecting a stop even if the model proposes one.

Actual iOS UI: 5/5 passed, including a six-message real DeepSeek dialogue typed into the text field, B4 lookup through the fixture gateway, maximum Dynamic Type, feature flag round-trip/persistence, and correction/submission through the test booking service. Swift unit run: 52 passed, 1 live-hub integration test skipped. Gateway: 22/22 passed. New signed build installed and launched on the physical iPhone; phone speech/noise testing is still separate.

Phone cache inspection: 5,210 stops. The user example exists as stop 28031, Bef The Synergy, Boon Lay Way. Nearby name variants include 28041 The Synergy and 28049 Opp The Synergy. These are actual cached LTA records, separate from the synthetic UI fixtures.
