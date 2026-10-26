const React = require('react');
const {artworkSourceURL} = require('./RendererUtils');

// A display failure is not a library edit. Keep the original reference so an
// offline image can be retried or replaced without silently losing metadata.
class ArtworkImage extends React.Component {
  constructor(props) {
    super(props);
    this.state = {source: props.source || '', failed: false, loaded: false,
      placeholderFailed: false, attempt: 0};
  }

  static getDerivedStateFromProps(props, state) {
    if ((props.source || '') !== state.source) {
      return {source: props.source || '', failed: false, loaded: false,
        placeholderFailed: false, attempt: state.attempt + 1};
    }
    return null;
  }

  retry() {
    this.setState(state => ({failed: false, loaded: false, placeholderFailed: false,
      attempt: state.attempt + 1}));
  }

  render() {
    const {source, failed, loaded, placeholderFailed, attempt} = this.state;
    const actualImage = Boolean(source && !failed);
    const url = artworkSourceURL(actualImage ? source : '',
      this.props.placeholder || '../../images/qmark.png', this.props.artworkDirectory);
    const current = () => source === this.state.source && attempt === this.state.attempt &&
      actualImage === Boolean(this.state.source && !this.state.failed);
    return (
      <div className={`artwork-preview ${this.props.className || ''}`} data-artwork-state={failed ? 'unavailable' : source ? 'image' : 'empty'}>
        {this.props.backdrop && actualImage && loaded && (
          <div className="optional-artwork-duplicate" aria-hidden="true"
            style={{backgroundImage: `url(${JSON.stringify(url)})`}} />
        )}
        {!placeholderFailed ? (
          <img key={`${url}:${attempt}`} id={this.props.imageID} src={url}
            className="artwork-preview-image"
            alt={actualImage ? (this.props.alt || 'Artwork') : failed ? 'Artwork unavailable' : 'No artwork'}
            onLoad={() => { if (current()) this.setState({loaded: true}); }}
            onError={() => {
              if (current()) this.setState(actualImage ? {failed: true, loaded: false} : {placeholderFailed: true});
            }} />
        ) : <span className="artwork-empty-label">No artwork</span>}
        {failed && this.props.showStatus && (
          <div className="artwork-unavailable" role="status">
            <span>Artwork unavailable</span>
            {this.props.allowRetry && <button type="button" onClick={() => this.retry()}>Retry</button>}
          </div>
        )}
        {this.props.children}
      </div>
    );
  }
}

module.exports = ArtworkImage;
