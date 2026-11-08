import { definePart, runSections } from '../part';
import memory from './queues/memory';
import kafka from './queues/kafka';
import sqs from './queues/sqs';
import rabbit from './queues/rabbit';
import ui from './queues/ui';

export default definePart({
  name: 'queues',
  summary: 'Queues: Kafka, SQS and RabbitMQ',
  run: (t) => runSections(t, [memory, kafka, sqs, rabbit, ui]),
});
