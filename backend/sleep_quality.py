"""Transparent experimental index, not Xiaomi's score or a clinical assessment.

All room statistics and plotted values are restricted to wearable ASLEEP stages.
No environmental data is fabricated during awake/unknown intervals or outages.
"""
import math

ASLEEP = {'light', 'deep', 'rem', 'sleeping'}
AWAKE = {'awake', 'awake_in_bed', 'out_of_bed'}
# Temperature 19-23 C: Baniassadi et al. 2023 (Sci Total Environ 899:165623) found 20-25 C best
# for sleep efficiency; Han et al. 2025 (Build Res Inf 53(5)) saw most home nights at 21-23 C,
# with restlessness rising as it warmed. Humidity 40-60 %: US EPA advises keeping RH below 60 %;
# Okamoto-Mizuno et al. (1999, 2005) show humid heat adds wake time and cuts SWS/REM.
# Overridable per deployment (SLEEP_TEMP_LOW etc. in config.py).
DEFAULT_IDEAL = {'temp_low':19.0,'temp_high':23.0,'hum_low':40.0,'hum_high':60.0}


def asleep_environment(rows, stages, ideal):
    intervals=[]
    for stage in stages:
        if stage['stage'] not in ASLEEP:
            continue
        a,b=stage['start'],stage['end']
        if intervals and a==intervals[-1][1]:
            intervals[-1][1]=b
        else: intervals.append([a,b])
    asleep_sec=sum(b-a for a,b in intervals)
    weighted=[]
    buckets={}
    rows=[r for r in sorted(rows) if math.isfinite(r[1]) and math.isfinite(r[2])]
    for i,(ts,temp,hum) in enumerate(rows):
        segment=next((j for j,(a,b) in enumerate(intervals) if a<=ts<b),None)
        if segment is None:
            continue
        _,end=intervals[segment]
        next_ts=rows[i+1][0] if i+1<len(rows) else ts+30
        weight=max(0,min(30,next_ts-ts,end-ts))
        if weight<=0: continue
        weighted.append((temp,hum,weight))
        buckets.setdefault((segment,int(ts//60)),[]).append((ts,temp,hum,weight))
    observed=sum(w for _,_,w in weighted)
    coverage=min(1,observed/asleep_sec) if asleep_sec else 0
    temperature=sum(t*w for t,_,w in weighted)/observed if observed else None
    humidity=sum(h*w for _,h,w in weighted)/observed if observed else None
    # Swings within the night, not just the average (Han et al. 2025 linked fluctuations
    # to restlessness). Time-weighted standard deviation over asleep samples only.
    temperature_sd=math.sqrt(sum(w*(t-temperature)**2 for t,_,w in weighted)/observed) if observed else None
    humidity_sd=math.sqrt(sum(w*(h-humidity)**2 for _,h,w in weighted)/observed) if observed else None
    scores=[]
    for temp,hum,weight in weighted:
        t_out=max(ideal['temp_low']-temp,temp-ideal['temp_high'],0)
        h_out=max(ideal['hum_low']-hum,hum-ideal['hum_high'],0)
        score=100-min(10*t_out,50)-min(2.5*h_out,50)
        scores.append(score*weight)
    environment_score=sum(scores)/observed if observed else None
    series=[]
    for (segment,_),values in sorted(buckets.items()):
        weight=sum(v[3] for v in values)
        series.append({'ts':values[0][0],'segment':segment,
                       'temperature':sum(v[1]*v[3] for v in values)/weight,
                       'humidity':sum(v[2]*v[3] for v in values)/weight})
    return {'samples':len(weighted),'coverage':round(coverage,3),
            'observed_minutes':round(observed/60,1),'asleep_minutes':round(asleep_sec/60,1),
            'temperature_avg':round(temperature,2) if temperature is not None else None,
            'humidity_avg':round(humidity,2) if humidity is not None else None,
            'temperature_sd':round(temperature_sd,2) if temperature_sd is not None else None,
            'humidity_sd':round(humidity_sd,2) if humidity_sd is not None else None},series,environment_score


def night_scores(totals, session_minutes, environment, room_score, target_hours, ideal):
    """Two separate scores, never merged into one number.

    The watch measures the outcome (sleep); the room sensor measures a possible cause.
    No published study validates a weighting between them, and a single number would let
    a perfect room hide a short night. The relationship is shown across nights instead.
    """
    asleep=sum(v for k,v in totals.items() if k in ASLEEP)
    awake=sum(v for k,v in totals.items() if k in AWAKE)
    classified=asleep+awake
    watch_coverage=min(1,classified/session_minutes) if session_minutes else 0
    # Some wearables (Mi Fitness/Xiaomi, by default) never report an awake stage.
    # If none ever appears, call continuity "unreported" rather than a perfect 100 %.
    has_awake_stages=any(k in AWAKE for k in totals)
    continuity=100*asleep/classified if classified and has_awake_stages else None
    # Duration against the personal target (AASM/SRS: at least 7 h for adults).
    duration=min(100,100*asleep/(target_hours*60))
    if watch_coverage<0.9:
        sleep=None
    elif continuity is not None:
        sleep=(duration+continuity)/2
    else:
        sleep=duration
    room=room_score if environment['coverage']>=0.8 and room_score is not None else None
    return {'version':'separate-v2',
            'sleep_score':round(sleep,1) if sleep is not None else None,
            'room_score':round(room,1) if room is not None else None,
            'duration_component':round(duration,1),
            'continuity_component':round(continuity,1) if continuity is not None else None,
            'has_awake_stages':has_awake_stages,
            'watch_coverage':round(watch_coverage,3),'target_hours':target_hours,'ideal':ideal,
            'sleep_missing':None if sleep is not None else 'insufficient_sleep_stages',
            'room_missing':None if room is not None else 'insufficient_room_readings',
            'notice':'Experimental Thalpos scores, not the Xiaomi sleep score or a medical assessment.'}
