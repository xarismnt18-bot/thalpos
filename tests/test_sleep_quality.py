import pytest

from backend.sleep_quality import DEFAULT_IDEAL, asleep_environment, combined_index


def stage(start,end,name): return {'start':start,'end':end,'stage':name}


def test_awake_unknown_and_outside_readings_do_not_enter_environment():
    stages=[stage(60,120,'deep'),stage(120,150,'awake'),stage(150,180,'rem'),stage(180,240,'unknown')]
    rows=[(30,99,99),(60,18,50),(90,18,50),(120,99,99),(150,18,50),(180,99,99),(240,99,99)]
    summary,series,score=asleep_environment(rows,stages,DEFAULT_IDEAL)
    assert summary['temperature_avg']==18 and summary['humidity_avg']==50
    assert summary['coverage']==1 and summary['observed_minutes']==1.5
    assert score==100
    assert all(60<=p['ts']<120 or 150<=p['ts']<180 for p in series)
    assert len({p['segment'] for p in series})==2


def test_short_awake_period_splits_lines_even_within_same_minute():
    stages=[stage(0,20,'light'),stage(20,25,'awake'),stage(25,60,'deep')]
    summary,series,_=asleep_environment([(0,18,50),(25,18,50),(55,18,50)],stages,DEFAULT_IDEAL)
    assert len(series)==2 and series[0]['segment']!=series[1]['segment']
    assert series[1]['ts']==25
    assert summary['coverage']==1


def test_missing_hours_are_not_filled_or_scored_as_observed():
    summary,series,score=asleep_environment([(0,18,50),(3600,18,50)],[stage(0,7200,'deep')],DEFAULT_IDEAL)
    assert summary['observed_minutes']==1
    assert summary['coverage']<0.01
    result=combined_index({'deep':120},120,summary,score,8,DEFAULT_IDEAL)
    assert result['combined'] is None and result['room_component'] is None
    assert result['missing']=='insufficient_room_readings'


def test_explicit_equal_weight_index_and_personal_duration_target():
    environment={'coverage':1}
    result=combined_index({'deep':120,'light':120,'awake':240},480,environment,100,8,DEFAULT_IDEAL)
    assert result['duration_component']==50
    assert result['continuity_component']==50
    assert result['watch_component']==50
    assert result['room_component']==100
    assert result['combined']==75
    shorter_target=combined_index({'light':240,'awake':240},480,environment,100,4,DEFAULT_IDEAL)
    assert shorter_target['combined']==87.5


def test_unknown_watch_intervals_prevent_combined_score():
    result=combined_index({'light':60,'unknown':60},120,{'coverage':1},100,8,DEFAULT_IDEAL)
    assert result['watch_component'] is None and result['combined'] is None
    assert result['missing']=='insufficient_sleep_stages'


def test_environment_penalty_is_time_weighted_and_bounded():
    summary,_,score=asleep_environment([(0,18,50),(30,22,50)],[stage(0,60,'deep')],DEFAULT_IDEAL)
    assert summary['coverage']==1
    assert score==90
    _,_,extreme=asleep_environment([(0,60,100)],[stage(0,30,'deep')],DEFAULT_IDEAL)
    assert extreme==0


def test_no_asleep_stages_means_no_environment_values():
    summary,series,score=asleep_environment([(0,18,50)],[stage(0,60,'awake')],DEFAULT_IDEAL)
    assert summary['samples']==0 and summary['temperature_avg'] is None
    assert series==[] and score is None
