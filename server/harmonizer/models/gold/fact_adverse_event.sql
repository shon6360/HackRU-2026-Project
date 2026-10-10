-- @description Adverse events recorded in EDC, keyed to the master subject and site.
-- @owner Clinical Data Management
-- @tags patient_level
-- @grain one row per adverse event
-- @col ae_key: Event key: subject key, hash, EDC sequence number, e.g. 701-1015#3
-- @col subject_key: Master subject key
-- @col site_key: Master site key
-- @col preferred_term: MedDRA preferred term
-- @col body_system: MedDRA system organ class
-- @col severity: MILD / MODERATE / SEVERE
-- @col is_serious: Serious adverse event flag
-- @col is_reportable: True for serious or severe events with onset on or after screening. These must have a case in the safety database
-- @col onset_date: Onset date; null when EDC collected only a partial date
-- @col onset_date_raw: Onset exactly as collected, possibly partial
-- @col is_ongoing: True when no end date has been recorded
SELECT
    m.subject_key || '#' || a.ae_seq AS ae_key,
    m.subject_key,
    m.site_key,
    a.ae_seq,
    a.preferred_term,
    a.body_system,
    a.severity,
    a.is_serious,
    (a.is_serious OR a.severity = 'SEVERE')
        AND substr(a.onset_date_raw, 1, 10) >= strftime(e.screening_date, '%Y-%m-%d') AS is_reportable,
    a.relatedness,
    a.outcome,
    a.onset_date,
    a.onset_date_raw,
    a.end_date,
    a.end_date IS NULL AS is_ongoing,
    a._src_system, a._src_file, a._src_row
FROM silver.edc_adverse_events a
JOIN master.subject m USING (usubjid)
JOIN silver.edc_subjects e USING (usubjid)
