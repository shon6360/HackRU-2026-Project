-- @description Screened subjects from the EDC demographics form (SDTM DM), typed and renamed.
-- @owner Clinical Data Management
-- @tags patient_level
-- @grain one row per screened subject
-- @standard CDISC SDTM DM
-- @col usubjid: EDC unique subject identifier, e.g. 01-701-1015 (SDTM USUBJID)
-- @col subject_number: Subject number within the study (SDTM SUBJID)
-- @col site_id_src: Site identifier exactly as EDC writes it, e.g. 701 (SDTM SITEID)
-- @col screening_date: Date of the screening visit / demographics collection (SDTM DMDTC)
-- @col first_dose_date: First study treatment date; null until the subject is randomized and dosed (SDTM RFSTDTC)
-- @col last_contact_date: End of participation, null while ongoing (SDTM RFENDTC)
-- @col age: Age in years at screening
-- @col sex: M / F
-- @col arm [unblinded]: Planned treatment arm. 'Screen Failure' for subjects never randomized (SDTM ARM)
-- @col arm_code [unblinded]: Short arm code (SDTM ARMCD)
-- @col is_screen_failure: True when the subject failed screening. Derived from ARM but does not reveal treatment
SELECT
    studyid                      AS study_id_src,
    usubjid,
    subjid                       AS subject_number,
    siteid                       AS site_id_src,
    TRY_CAST(dmdtc AS DATE)      AS screening_date,
    TRY_CAST(rfstdtc AS DATE)    AS first_dose_date,
    TRY_CAST(rfendtc AS DATE)    AS last_contact_date,
    TRY_CAST(age AS INTEGER)     AS age,
    sex,
    race,
    ethnic                       AS ethnicity,
    arm,
    armcd                        AS arm_code,
    arm = 'Screen Failure'       AS is_screen_failure,
    COALESCE(dthfl = 'Y', FALSE) AS died,
    country,
    _src_system, _src_file, _src_row
FROM bronze.edc_dm
