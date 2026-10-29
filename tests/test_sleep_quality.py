import pytest

from backend.sleep_quality import DEFAULT_IDEAL, asleep_environment, night_scores


def stage(start,end,name): return {'start':start,'end':end,'stage':name}


def test_awake_unknown_and_outside_readings_do_not_enter_environment():
    stages=[stage(60,120,'deep'),stage(120,150,'awake'),stage(150,180,'rem'),stage(180,240,'unknown')]
    rows=[(30,99,99),(60,21,50),(90,21,50),(120,99,99),(150,21,50),(180,99,99),(240,99,99)]
    summary,series,score=asleep_environment(rows,stages,DEFAULT_IDEAL)
    assert summary['temperature_avg']==21 and summary['humidity_avg']==50
    assert summary['coverage']==1 and summary['observed_minutes']==1.5
    assert score==100
    assert all(60<=p['ts']<120 or 150<=p['ts']<180 for p in series)
    assert len({p['segment'] for p in series})==2


def test_short_awake_period_splits_lines_even_within_same_minute():
    stages=[stage(0,20,'light'),stage(20,25,'awake'),stage(25,60,'deep')]
    summary,series,_=asleep_environment([(0,21,50),(25,21,50),(55,21,50)],stages,DEFAULT_IDEAL)
    assert len(series)==2 and series[0]['segment']!=series[1]['segment']
    assert series[1]['ts']==25
    assert summary['coverage']==1


def test_missing_hours_are_not_filled_or_scored_as_observed():
    summary,series,score=asleep_environment([(0,21,50),(3600,21,50)],[stage(0,7200,'deep')],DEFAULT_IDEAL)
    assert summary['observed_minutes']==1
    assert summary['coverage']<0.01
    result=night_scores({'deep':120},120,summary,score,8,DEFAULT_IDEAL)
    assert result['room_score'] is None and result['room_missing']=='insufficient_room_readings'
    assert result['sleep_score'] is not None   # one missing source never hides the other


def test_sleep_and_room_are_separate_scores_never_merged():
    environment={'coverage':1}
    result=night_scores({'deep':120,'light':120,'awake':240},480,environment,100,8,DEFAULT_IDEAL)
    assert result['duration_component']==50
    assert result['continuity_component']==50
    assert result['sleep_score']==50
    assert result['room_score']==100
    assert 'combined' not in result and 'weights' not in result
    shorter_target=night_scores({'light':240,'awake':240},480,environment,100,4,DEFAULT_IDEAL)
    assert shorter_target['sleep_score']==75


def test_unknown_watch_intervals_prevent_sleep_score_only():
    result=night_scores({'light':60,'unknown':60},120,{'coverage':1},100,8,DEFAULT_IDEAL)
    assert result['sleep_score'] is None and result['sleep_missing']=='insufficient_sleep_stages'
    assert result['room_score']==100


def test_environment_penalty_is_time_weighted_and_bounded():
    summary,_,score=asleep_environment([(0,21,50),(30,25,50)],[stage(0,60,'deep')],DEFAULT_IDEAL)
    assert summary['coverage']==1
    assert score==90
    _,_,extreme=asleep_environment([(0,60,100)],[stage(0,30,'deep')],DEFAULT_IDEAL)
    assert extreme==0


def test_no_asleep_stages_means_no_environment_values():
    summary,series,score=asleep_environment([(0,21,50)],[stage(0,60,'awake')],DEFAULT_IDEAL)
    assert summary['samples']==0 and summary['temperature_avg'] is None
    assert series==[] and score is None


def test_watch_score_still_computed_when_wearable_omits_awake_stages():
    environment={'coverage':1}
    # Mi Fitness pattern: only sleep stages, never an awake interval
    result=night_scores({'light':240,'deep':150,'rem':60},480,environment,80,8,DEFAULT_IDEAL)
    assert result['has_awake_stages'] is False
    assert result['continuity_component'] is None
    # sleep score falls back to duration alone instead of a 100 % continuity invention
    assert result['sleep_score']==round(100*(240+150+60)/480,1)
    assert result['sleep_missing'] is None and result['room_missing'] is None


def test_default_bands_match_the_cited_sources():
    # 19-23 C (Baniassadi 2023, Han 2025); RH below 60 % (US EPA)
    assert (DEFAULT_IDEAL['temp_low'],DEFAULT_IDEAL['temp_high'])==(19.0,23.0)
    assert (DEFAULT_IDEAL['hum_low'],DEFAULT_IDEAL['hum_high'])==(40.0,60.0)


def test_a_typical_night_inside_the_band_is_not_penalised():
    _,_,score=asleep_environment([(0,21.5,55),(30,22.5,58)],[stage(0,60,'light')],DEFAULT_IDEAL)
    assert score==100
    _,_,warm=asleep_environment([(0,24,55)],[stage(0,30,'light')],DEFAULT_IDEAL)
    assert warm==90   # 1 C above the band costs 10 points


def test_swings_within_the_night_are_measured_on_asleep_time_only():
    stages=[stage(0,60,'light'),stage(60,120,'awake'),stage(120,180,'deep')]
    rows=[(0,20,50),(30,22,54),(60,40,90),(90,40,90),(120,20,50),(150,22,54)]
    summary,_,_=asleep_environment(rows,stages,DEFAULT_IDEAL)
    assert summary['temperature_avg']==21 and summary['temperature_sd']==1
    assert summary['humidity_sd']==2
    steady,_,_=asleep_environment([(0,21,50),(30,21,50)],[stage(0,60,'light')],DEFAULT_IDEAL)
    assert steady['temperature_sd']==0
    empty,_,_=asleep_environment([],[stage(0,60,'light')],DEFAULT_IDEAL)
    assert empty['temperature_sd'] is None
