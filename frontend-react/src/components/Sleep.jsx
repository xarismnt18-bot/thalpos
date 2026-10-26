import WearableSleep from './WearableSleep';

export default function Sleep({ room }) {
  return <div className="module-page">
    <h1>Sleep</h1>
    <p className="module-subtitle">Οι ώρες ύπνου προέρχονται από το ρολόι σου. Η θερμοκρασία και η υγρασία εμφανίζονται μόνο στα διαστήματα που κατέγραψε ως ύπνο. Οι αφυπνίσεις παραμένουν ορατές στη χρονογραμμή.</p>
    <WearableSleep room={room}/>
  </div>;
}
