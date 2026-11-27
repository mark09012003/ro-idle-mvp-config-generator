import {attackSkills, simulate, targets} from "./engine.js";

self.onmessage = ({data: {id, action, snapshot, options}}) => {
  try {
    const result = {
      targets: () => targets,
      skills: () => attackSkills(snapshot),
      simulate: () => simulate(snapshot, options),
    }[action]();
    self.postMessage({id, result});
  } catch (error) {
    self.postMessage({id, error: error.message});
  }
};
